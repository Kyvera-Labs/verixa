import { describe, expect, it } from "vitest";

import {
  classifyTestExecution,
  parseQuarantineTag,
  evaluateQuarantine,
  recordFlakyTest,
  formatFlakyReportMarkdown,
  type FlakyLedger,
  type QuarantineMetadata,
} from "../../infra/ci/flaky-test-tracker.js";

describe("flaky-test-tracker (Issue 414)", () => {
  describe("classifyTestExecution", () => {
    it("classifies test as stable when first attempt passes", () => {
      const attempts = [{ attempt: 1, passed: true, durationMs: 120 }];

      const res = classifyTestExecution("tests/unit/example.spec.ts", attempts, 2);

      expect(res.classification).toBe("stable");
      expect(res.passed).toBe(true);
      expect(res.message).toContain("passed cleanly");
    });

    it("classifies test as flaky when attempt 1 fails but attempt 2 passes", () => {
      const attempts = [
        { attempt: 1, passed: false, error: "Connection timeout" },
        { attempt: 2, passed: true, durationMs: 150 },
      ];

      const res = classifyTestExecution("tests/integration/redis.spec.ts", attempts, 2);

      expect(res.classification).toBe("flaky");
      expect(res.passed).toBe(true);
      expect(res.message).toContain("Test is FLAKY");
      expect(res.message).toContain("passed on retry 2");
    });

    it("classifies test as failing when all attempts fail", () => {
      const attempts = [
        { attempt: 1, passed: false, error: "SyntaxError" },
        { attempt: 2, passed: false, error: "SyntaxError" },
        { attempt: 3, passed: false, error: "SyntaxError" },
      ];

      const res = classifyTestExecution("tests/integration/db.spec.ts", attempts, 2);

      expect(res.classification).toBe("failing");
      expect(res.passed).toBe(false);
      expect(res.message).toContain("consistently failed");
    });

    it("classifies as failing if pass occurred beyond maxRetries boundary", () => {
      // If maxRetries is 1, attempt 3 should not count as valid retry
      const attempts = [
        { attempt: 1, passed: false },
        { attempt: 2, passed: false },
        { attempt: 3, passed: true },
      ];

      const res = classifyTestExecution("tests/load/heavy.spec.ts", attempts, 1);

      expect(res.classification).toBe("failing");
      expect(res.passed).toBe(false);
    });
  });

  describe("parseQuarantineTag", () => {
    it("parses full tag with until, reason, issue, and owner", () => {
      const line =
        'it.skip("@quarantine(until=2026-12-15, reason=\\"Flaky socket close\\", issue=\\"#414\\", owner=\\"@modric\\")", () => {})';
      const meta = parseQuarantineTag(line, "tests/e2e/auth.spec.ts");

      expect(meta).not.toBeNull();
      expect(meta?.testId).toBe("tests/e2e/auth.spec.ts");
      expect(meta?.until).toBe("2026-12-15");
      expect(meta?.reason).toBe("Flaky socket close");
      expect(meta?.issue).toBe("#414");
      expect(meta?.owner).toBe("@modric");
    });

    it("parses unquoted and single-quoted parameters", () => {
      const line = "@quarantine(until=2026-12-01, reason='Intermittent race', issue=#520)";
      const meta = parseQuarantineTag(line, "tests/unit/race.spec.ts");

      expect(meta).not.toBeNull();
      expect(meta?.until).toBe("2026-12-01");
      expect(meta?.reason).toBe("Intermittent race");
      expect(meta?.issue).toBe("#520");
    });

    it("returns null if not a quarantine tag or missing required until field", () => {
      expect(parseQuarantineTag("it('normal test case', () => {})")).toBeNull();
      expect(parseQuarantineTag("@quarantine(reason='Missing date')")).toBeNull();
    });
  });

  describe("evaluateQuarantine", () => {
    const fixedNow = new Date("2026-11-19T12:00:00Z");

    it("identifies active quarantine and permits skipping", () => {
      const meta: QuarantineMetadata = {
        testId: "tests/integration/session.spec.ts",
        until: "2026-12-01",
        reason: "Redis cluster failover test flakiness",
        issue: "#414",
      };

      const evalResult = evaluateQuarantine(meta, fixedNow);

      expect(evalResult.status).toBe("active");
      expect(evalResult.isExpired).toBe(false);
      expect(evalResult.shouldSkip).toBe(true);
      expect(evalResult.daysRemainingOrOverdue).toBeGreaterThan(0);
      expect(evalResult.diagnostic).toContain("Quarantine ACTIVE");
    });

    it("identifies expired quarantine and forbids skipping (must re-fail)", () => {
      const meta: QuarantineMetadata = {
        testId: "tests/integration/expired.spec.ts",
        until: "2026-11-01", // in the past relative to 2026-11-19
        reason: "Old flakiness that was supposed to be fixed",
        issue: "#300",
      };

      const evalResult = evaluateQuarantine(meta, fixedNow);

      expect(evalResult.status).toBe("expired");
      expect(evalResult.isExpired).toBe(true);
      expect(evalResult.shouldSkip).toBe(false); // MUST NOT SKIP!
      expect(evalResult.daysRemainingOrOverdue).toBe(18); // 18 days overdue
      expect(evalResult.diagnostic).toContain("Quarantine EXPIRED");
    });

    it("marks invalid date format as invalid and does not skip", () => {
      const meta: QuarantineMetadata = {
        testId: "tests/integration/invalid.spec.ts",
        until: "next-week",
        reason: "Bad date",
      };

      const evalResult = evaluateQuarantine(meta, fixedNow);

      expect(evalResult.status).toBe("invalid");
      expect(evalResult.shouldSkip).toBe(false);
      expect(evalResult.diagnostic).toContain("Invalid quarantine expiration date format");
    });
  });

  describe("recordFlakyTest", () => {
    it("creates a new record and increments on recurrence", () => {
      const ledger: FlakyLedger = {
        version: 1,
        updatedAt: "2026-11-19T00:00:00.000Z",
        tests: {},
      };

      const firstRecord = recordFlakyTest(
        ledger,
        "tests/integration/token.spec.ts",
        [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ],
        new Date("2026-11-19T10:00:00Z"),
      );

      expect(firstRecord.flakinessCount).toBe(1);
      expect(ledger.tests["tests/integration/token.spec.ts"]?.flakinessCount).toBe(1);

      const secondRecord = recordFlakyTest(
        ledger,
        "tests/integration/token.spec.ts",
        [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ],
        new Date("2026-11-19T12:00:00Z"),
      );

      expect(secondRecord.flakinessCount).toBe(2);
      expect(secondRecord.firstSeenAt).toBe("2026-11-19T10:00:00.000Z");
      expect(secondRecord.lastSeenAt).toBe("2026-11-19T12:00:00.000Z");
    });
  });

  describe("formatFlakyReportMarkdown", () => {
    it("formats markdown summary with tables", () => {
      const classifications = [
        classifyTestExecution("tests/integration/auth.spec.ts", [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ]),
      ];

      const quarantines = [
        evaluateQuarantine(
          {
            testId: "tests/integration/redis.spec.ts",
            until: "2026-12-10",
            reason: "Timeout under worker saturation",
            issue: "#414",
          },
          new Date("2026-11-19T00:00:00Z"),
        ),
      ];

      const md = formatFlakyReportMarkdown(classifications, quarantines);

      expect(md).toContain("## Flaky Test & Quarantine Report (Issue 414)");
      expect(md).toContain("### ⚠️ Flaky Tests (1)");
      expect(md).toContain("tests/integration/auth.spec.ts");
      expect(md).toContain("### 🔒 Quarantined Tests (1)");
      expect(md).toContain("tests/integration/redis.spec.ts");
    });

    it("formats warning when quarantine has expired", () => {
      const quarantines = [
        evaluateQuarantine(
          {
            testId: "tests/integration/old.spec.ts",
            until: "2026-10-01",
            reason: "Ancient bug",
            issue: "#101",
          },
          new Date("2026-11-19T00:00:00Z"),
        ),
      ];

      const md = formatFlakyReportMarkdown([], quarantines);

      expect(md).toContain("### 🚨 Expired Quarantines Alert");
      expect(md).toContain("tests/integration/old.spec.ts");
      expect(md).toContain("Action Required");
    });
  });
});
