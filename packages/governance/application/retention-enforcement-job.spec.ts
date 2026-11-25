import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { RetentionRule, type RetentionAction } from "../domain/retention-rule.js";
import { InMemoryRetentionActionLog } from "../infrastructure/in-memory-retention-action-log.js";

import type { RetentionRuleSource } from "./ports/retention-ports.js";
import type { ApplyOutcome, RetentionTarget } from "./ports/retention-target.js";
import { RetentionEnforcementJob } from "./retention-enforcement-job.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00Z");

function ruleOf(params: {
  resourceType: string;
  action: string;
  retentionDays?: number;
}): RetentionRule {
  const result = RetentionRule.create({
    organizationId: "org_1",
    retentionDays: 30,
    ...params,
  });
  if (Result.isErr(result)) throw result.error;
  return result.value;
}

const source = (...rules: RetentionRule[]): RetentionRuleSource => ({
  listActiveRules: () => Promise.resolve(rules),
});

/** A target over a mutable set of records, each with an age in days. */
class FakeTarget implements RetentionTarget {
  readonly applyCalls: { resourceId: string; action: RetentionAction }[] = [];
  readonly done = new Map<string, Set<RetentionAction>>();
  failOn = new Set<string>();

  constructor(
    readonly resourceType: RetentionTarget["resourceType"],
    readonly supportedActions: readonly RetentionAction[],
    private readonly records: { id: string; endedAt: Date; orgId?: string }[],
  ) {}

  findExpired(q: { organizationId: string; action: RetentionAction; cutoff: Date; limit: number }) {
    return Promise.resolve(
      this.records
        .filter((r) => (r.orgId ?? "org_1") === q.organizationId)
        .filter((r) => r.endedAt.getTime() <= q.cutoff.getTime())
        .filter((r) => !this.done.get(r.id)?.has(q.action))
        .slice(0, q.limit)
        .map((r) => ({ resourceId: r.id })),
    );
  }

  apply(_org: string, resourceId: string, action: RetentionAction): Promise<ApplyOutcome> {
    this.applyCalls.push({ resourceId, action });
    if (this.failOn.has(resourceId)) return Promise.reject(new Error("boom"));
    const set = this.done.get(resourceId) ?? new Set<RetentionAction>();
    const already = set.has(action);
    set.add(action);
    this.done.set(resourceId, set);
    return Promise.resolve(already ? "already_applied" : "applied");
  }
}

const aged = (id: string, days: number, orgId?: string) => ({
  id,
  endedAt: new Date(NOW.getTime() - days * DAY),
  ...(orgId === undefined ? {} : { orgId }),
});

describe("RetentionEnforcementJob", () => {
  it("applies the rule's action to expired records only", async () => {
    const target = new FakeTarget(
      "sessions",
      ["delete", "anonymize"],
      [aged("old", 90), aged("recent", 5)],
    );
    const log = new InMemoryRetentionActionLog();
    const rule = ruleOf({ resourceType: "sessions", action: "delete" });

    const summary = await new RetentionEnforcementJob(source(rule), [target], log).run(NOW);

    expect(target.applyCalls).toEqual([{ resourceId: "old", action: "delete" }]);
    expect(summary).toMatchObject({ rulesEvaluated: 1, applied: 1, failed: 0, refused: 0 });
  });

  it("logs every action with rule id, resource id and action taken", async () => {
    const target = new FakeTarget("sessions", ["delete"], [aged("a", 60), aged("b", 61)]);
    const log = new InMemoryRetentionActionLog();
    const rule = ruleOf({ resourceType: "sessions", action: "delete" });

    await new RetentionEnforcementJob(source(rule), [target], log).run(NOW);

    expect(log.all().map((e) => [e.ruleId, e.resourceId, e.action, e.outcome])).toEqual([
      [rule.id, "a", "delete", "applied"],
      [rule.id, "b", "delete", "applied"],
    ]);
  });

  it("produces no duplicate side effects when re-run", async () => {
    const target = new FakeTarget("sessions", ["anonymize"], [aged("a", 60), aged("b", 61)]);
    const log = new InMemoryRetentionActionLog();
    const job = new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "anonymize" })),
      [target],
      log,
    );

    await job.run(NOW);
    const callsAfterFirst = target.applyCalls.length;
    const logAfterFirst = log.all().length;
    const second = await job.run(NOW);

    expect(target.applyCalls).toHaveLength(callsAfterFirst);
    expect(log.all()).toHaveLength(logAfterFirst);
    expect(second).toMatchObject({ applied: 0, alreadyApplied: 0, failed: 0 });
  });

  it("recovers from a crash between applying and logging without double processing", async () => {
    const target = new FakeTarget("sessions", ["delete"], [aged("a", 60), aged("b", 61)]);
    // The change to "a" happened, but the process died before it was logged.
    await target.apply("org_1", "a", "delete");
    target.applyCalls.length = 0;
    const log = new InMemoryRetentionActionLog();

    const summary = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      log,
    ).run(NOW);

    // "a" is no longer offered by the target; "b" is processed exactly once.
    expect(target.applyCalls).toEqual([{ resourceId: "b", action: "delete" }]);
    expect(summary.applied).toBe(1);
    const again = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      log,
    ).run(NOW);
    expect(again.applied).toBe(0);
  });

  it("skips work the log already shows as completed without calling the target", async () => {
    // A target that keeps offering the record (a non-conforming one) must still
    // not be applied to twice.
    const records = [aged("a", 60)];
    const target = new FakeTarget("sessions", ["delete"], records);
    target.findExpired = () => Promise.resolve([{ resourceId: "a" }]);
    const log = new InMemoryRetentionActionLog();
    const rule = ruleOf({ resourceType: "sessions", action: "delete" });
    const job = new RetentionEnforcementJob(source(rule), [target], log);

    await job.run(NOW);
    const second = await job.run(NOW);

    expect(target.applyCalls).toHaveLength(1);
    expect(second.skipped).toBe(1);
  });

  it("records a failure, carries on, and retries it on the next run", async () => {
    const target = new FakeTarget("sessions", ["delete"], [aged("a", 60), aged("b", 61)]);
    target.failOn.add("a");
    const log = new InMemoryRetentionActionLog();
    const job = new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      log,
    );

    const first = await job.run(NOW);
    expect(first).toMatchObject({ applied: 1, failed: 1 });
    expect(log.all().find((e) => e.outcome === "failed")).toMatchObject({
      resourceId: "a",
      detail: "boom",
    });

    target.failOn.clear();
    const second = await job.run(NOW);
    expect(second.applied).toBe(1);
    expect(target.done.get("a")?.has("delete")).toBe(true);
  });

  it("stops a rule's run when a whole batch makes no progress", async () => {
    const target = new FakeTarget("sessions", ["delete"], [aged("a", 60)]);
    target.failOn.add("a");
    const job = new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      new InMemoryRetentionActionLog(),
      { batchSize: 1 },
    );
    await job.run(NOW);
    expect(target.applyCalls).toHaveLength(1);
  });

  it("processes more records than one batch holds", async () => {
    const records = Array.from({ length: 7 }, (_, i) => aged(`r${i}`, 60 + i));
    const target = new FakeTarget("sessions", ["delete"], records);
    const summary = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      new InMemoryRetentionActionLog(),
      { batchSize: 3 },
    ).run(NOW);
    expect(summary.applied).toBe(7);
  });

  it("only touches the rule's own organization", async () => {
    const target = new FakeTarget(
      "sessions",
      ["delete"],
      [aged("mine", 60), aged("theirs", 60, "org_2")],
    );
    await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [target],
      new InMemoryRetentionActionLog(),
    ).run(NOW);
    expect(target.applyCalls.map((c) => c.resourceId)).toEqual(["mine"]);
  });

  it("refuses an action the target does not support", async () => {
    const target = new FakeTarget("verification", ["delete"], [aged("a", 60)]);
    const log = new InMemoryRetentionActionLog();
    const summary = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "verification", action: "archive" })),
      [target],
      log,
    ).run(NOW);
    expect(summary.refused).toBe(1);
    expect(target.applyCalls).toHaveLength(0);
    expect(log.all()[0]).toMatchObject({ outcome: "refused", resourceId: "*" });
  });

  it("refuses a rule with no registered target", async () => {
    const summary = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "sessions", action: "delete" })),
      [],
      new InMemoryRetentionActionLog(),
    ).run(NOW);
    expect(summary.refused).toBe(1);
  });
});

describe("audit records are never hard-deleted", () => {
  it("cannot be given a delete rule at creation", () => {
    for (const action of ["delete", "anonymize"]) {
      const result = RetentionRule.create({
        organizationId: "org_1",
        resourceType: "audit_export",
        retentionDays: 30,
        action,
      });
      expect(Result.isErr(result)).toBe(true);
    }
    expect(
      Result.isOk(
        RetentionRule.create({
          organizationId: "org_1",
          resourceType: "audit_export",
          retentionDays: 30,
          action: "archive",
        }),
      ),
    ).toBe(true);
  });

  it("is refused by the job even if a delete rule gets past creation", async () => {
    // A rule rebuilt from storage skips creation-time validation.
    const smuggled = RetentionRule.reconstitute({
      id: "rule_1" as never,
      organizationId: "org_1",
      resourceType: "audit_export",
      retentionDays: 1,
      action: "delete",
      active: true,
    });
    // Even a target that claims to support delete must never be asked to.
    const target = new FakeTarget("audit_export", ["delete", "archive"], [aged("evt", 365)]);
    const log = new InMemoryRetentionActionLog();

    const summary = await new RetentionEnforcementJob(source(smuggled), [target], log).run(NOW);

    expect(target.applyCalls).toEqual([]);
    expect(target.done.size).toBe(0);
    expect(summary.refused).toBe(1);
    expect(log.all()[0]).toMatchObject({ outcome: "refused", action: "delete" });
  });

  it("supports archival", async () => {
    const target = new FakeTarget("audit_export", ["archive"], [aged("evt", 365)]);
    const summary = await new RetentionEnforcementJob(
      source(ruleOf({ resourceType: "audit_export", action: "archive" })),
      [target],
      new InMemoryRetentionActionLog(),
    ).run(NOW);
    expect(target.applyCalls).toEqual([{ resourceId: "evt", action: "archive" }]);
    expect(summary.applied).toBe(1);
  });
});

describe("RetentionRule", () => {
  it("rejects unknown resource types, actions and non-positive periods", () => {
    const bad = RetentionRule.create({
      organizationId: "o",
      resourceType: "sesions",
      retentionDays: 0,
      action: "shred",
    });
    expect(Result.isErr(bad)).toBe(true);
    if (Result.isErr(bad)) {
      expect(Object.keys(bad.error.fieldErrors).sort()).toEqual([
        "action",
        "resourceType",
        "retentionDays",
      ]);
    }
  });

  it("computes the cutoff from the retention period", () => {
    const rule = ruleOf({ resourceType: "sessions", action: "delete", retentionDays: 30 });
    expect(rule.cutoffAt(NOW).toISOString()).toBe("2026-05-02T00:00:00.000Z");
  });
});
