import {
  InMemoryRetentionActionLog,
  RetentionEnforcementJob,
  RetentionRule,
  type RetentionTarget,
} from "@verixa/governance";
import {
  InMemorySessionRetentionStore,
  Session,
  SessionRetentionTarget,
  type SessionUserId,
} from "@verixa/sessions";
import { Result, createId } from "@verixa/shared-kernel";
import {
  InMemoryVerificationRetentionStore,
  VerificationRetentionTarget,
} from "@verixa/verification";
import { describe, expect, it } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00Z");

function rule(resourceType: string, action: string): RetentionRule {
  const result = RetentionRule.create({
    organizationId: "org_1",
    resourceType,
    retentionDays: 30,
    action,
  });
  if (Result.isErr(result)) throw result.error;
  return result.value;
}

describe("context retention targets joined to governance", () => {
  // The annotations below are the point: each context's target is assigned to
  // governance's port without either side importing the other. If a contract
  // method or type drifts, this file stops compiling.
  const user = createId<"UserId">() as SessionUserId;
  const endedSession = Session.reconstitute({
    id: createId<"SessionId">(),
    userId: user,
    createdAt: new Date(NOW.getTime() - 200 * DAY),
    lastSeenAt: new Date(NOW.getTime() - 200 * DAY),
    expiresAt: new Date(NOW.getTime() - 100 * DAY),
    ipAddress: "203.0.113.9",
    userAgent: "ua",
    revokedAt: undefined,
  });

  it("satisfy the RetentionTarget port and are driven by the job", async () => {
    const sessionStore = new InMemorySessionRetentionStore([endedSession]);
    const sessionTarget: RetentionTarget = new SessionRetentionTarget(sessionStore, () =>
      Promise.resolve([user]),
    );
    const verificationTarget: RetentionTarget = new VerificationRetentionTarget(
      new InMemoryVerificationRetentionStore(),
    );

    const log = new InMemoryRetentionActionLog();
    const job = new RetentionEnforcementJob(
      { listActiveRules: () => Promise.resolve([rule("sessions", "delete")]) },
      [sessionTarget, verificationTarget],
      log,
    );

    const first = await job.run(NOW);
    const second = await job.run(NOW);

    expect(first.applied).toBe(1);
    expect(sessionStore.has(endedSession.id)).toBe(false);
    expect(second).toMatchObject({ applied: 0, failed: 0 });
    expect(log.all()).toHaveLength(1);
  });
});
