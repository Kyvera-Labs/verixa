import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { ApprovalChain } from "./approval-chain.js";
import { ComplianceCase } from "./compliance-case.js";
import {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_TYPES,
  getWorkflowDefinition,
  isWorkflowType,
  type WorkflowType,
} from "./workflow-definitions.js";

function openCase(workflowType: WorkflowType): ComplianceCase {
  const result = ComplianceCase.open({
    organizationId: "org_1",
    workflowType,
    title: "Case",
    actorId: "usr_opener",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  if (Result.isErr(result)) throw result.error;
  return result.value;
}

function ok<T, E extends Error>(result: Result<T, E>): T {
  if (Result.isErr(result)) throw result.error;
  return result.value;
}

function approveAll(c: ComplianceCase): ComplianceCase {
  return c.approvalChain.requiredRoles.reduce(
    (acc, role) =>
      ok(acc.recordApproval({ role, approverId: `usr_${role}`, decision: "approved" })),
    c,
  );
}

describe("workflow definitions", () => {
  it.each(WORKFLOW_TYPES)("%s is a well-formed state machine", (type) => {
    const def = getWorkflowDefinition(type);
    const states = new Set<string>([def.initialState]);
    for (const [from, events] of Object.entries(def.transitions)) {
      states.add(from);
      for (const rule of Object.values(events)) states.add(rule.to);
    }

    // Terminal states have no outgoing edges; every non-terminal has some.
    for (const terminal of def.terminalStates) {
      expect(def.transitions[terminal]).toBeUndefined();
    }
    for (const state of states) {
      if (!def.terminalStates.includes(state)) {
        expect(Object.keys(def.transitions[state] ?? {}).length).toBeGreaterThan(0);
      }
    }

    // Every state is reachable from the initial state.
    const reached = new Set<string>([def.initialState]);
    const queue = [def.initialState];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const rule of Object.values(def.transitions[current] ?? {})) {
        if (!reached.has(rule.to)) {
          reached.add(rule.to);
          queue.push(rule.to);
        }
      }
    }
    expect([...reached].sort()).toEqual([...states].sort());
    expect(def.approvalRoles.length).toBeGreaterThanOrEqual(2);
  });

  it("recognises only known workflow types", () => {
    expect(isWorkflowType("verification-review")).toBe(true);
    expect(isWorkflowType("made-up")).toBe(false);
    expect(Object.keys(WORKFLOW_DEFINITIONS)).toEqual([...WORKFLOW_TYPES]);
  });
});

describe("ComplianceCase transitions", () => {
  it("rejects a blank title", () => {
    const result = ComplianceCase.open({
      organizationId: "org_1",
      workflowType: "verification-review",
      title: "   ",
      actorId: "u",
    });
    expect(Result.isErr(result)).toBe(true);
  });

  it("starts in the workflow's initial state with an opening history entry", () => {
    const c = openCase("data-subject-request");
    expect(c.state).toBe("received");
    expect(c.history).toEqual([
      {
        fromState: null,
        toState: "received",
        event: "opened",
        actorId: "usr_opener",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(c.pendingEvents.map((e) => e.eventName)).toEqual(["governance.compliance_case.opened"]);
  });

  it("follows the legal path of a verification review", () => {
    let c = openCase("verification-review");
    c = ok(c.transition({ event: "begin_review", actorId: "a1" }));
    expect(c.state).toBe("under_review");
    c = ok(c.transition({ event: "escalate", actorId: "a2" }));
    expect(c.state).toBe("escalated");
    c = ok(c.transition({ event: "dismiss", actorId: "a3" }));
    expect(c.state).toBe("dismissed");
    expect(c.isTerminal).toBe(true);
  });

  it("follows the legal path of a data subject request, through a different table", () => {
    let c = openCase("data-subject-request");
    c = ok(c.transition({ event: "verify_identity", actorId: "a1" }));
    c = ok(c.transition({ event: "start_fulfilment", actorId: "a1" }));
    expect(c.state).toBe("in_progress");
    expect(c.availableEvents).toEqual(["fulfil", "reject"]);
  });

  it("rejects an event that is not in the table for the current state", () => {
    const c = openCase("verification-review");
    const result = c.transition({ event: "confirm", actorId: "a1" });
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) expect(result.error.message).toContain('"flagged"');
  });

  it("does not accept another workflow's event", () => {
    const c = openCase("verification-review");
    expect(Result.isErr(c.transition({ event: "verify_identity", actorId: "a" }))).toBe(true);
  });

  it("does not accept a target state name as an event", () => {
    const c = openCase("verification-review");
    expect(Result.isErr(c.transition({ event: "under_review", actorId: "a" }))).toBe(true);
  });

  it("accepts no event once terminal", () => {
    let c = openCase("verification-review");
    c = ok(c.transition({ event: "dismiss", actorId: "a" }));
    for (const event of ["begin_review", "dismiss", "confirm", "escalate"]) {
      expect(Result.isErr(c.transition({ event, actorId: "a" }))).toBe(true);
    }
  });

  it("applies and clears assignee as part of a transition", () => {
    let c = openCase("verification-review");
    c = ok(c.transition({ event: "begin_review", actorId: "a", assigneeId: "usr_2" }));
    expect(c.assigneeId).toBe("usr_2");
    c = ok(c.transition({ event: "escalate", actorId: "a" }));
    expect(c.assigneeId).toBe("usr_2");
    c = ok(c.transition({ event: "dismiss", actorId: "a", assigneeId: null }));
    expect(c.assigneeId).toBeNull();
  });

  it("does not mutate the original case", () => {
    const original = openCase("verification-review");
    ok(original.transition({ event: "begin_review", actorId: "a" }));
    expect(original.state).toBe("flagged");
    expect(original.history).toHaveLength(1);
    expect(original.version).toBe(1);
  });
});

describe("ComplianceCase state history", () => {
  it("records every move in order with actor and timestamp", () => {
    let c = openCase("verification-review");
    c = ok(
      c.transition({
        event: "begin_review",
        actorId: "alice",
        now: new Date("2026-01-02T00:00:00Z"),
      }),
    );
    c = ok(
      c.transition({ event: "escalate", actorId: "bob", now: new Date("2026-01-03T00:00:00Z") }),
    );

    expect(c.history.map((h) => [h.fromState, h.toState, h.event, h.actorId])).toEqual([
      [null, "flagged", "opened", "usr_opener"],
      ["flagged", "under_review", "begin_review", "alice"],
      ["under_review", "escalated", "escalate", "bob"],
    ]);
    expect(c.history.map((h) => h.occurredAt.toISOString())).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });

  it("is chained: each entry starts where the previous one ended", () => {
    let c = openCase("data-subject-request");
    c = ok(c.transition({ event: "verify_identity", actorId: "a" }));
    c = ok(c.transition({ event: "start_fulfilment", actorId: "a" }));
    c = ok(c.transition({ event: "reject", actorId: "a" }));
    for (let i = 1; i < c.history.length; i++) {
      expect(c.history[i]?.fromState).toBe(c.history[i - 1]?.toState);
    }
    expect(c.history.at(-1)?.toState).toBe(c.state);
  });

  it("is not changed by a refused transition", () => {
    const c = openCase("verification-review");
    const before = c.history.length;
    c.transition({ event: "confirm", actorId: "a" });
    expect(c.history).toHaveLength(before);
  });

  it("increments the version once per accepted change", () => {
    let c = openCase("verification-review");
    c = ok(c.transition({ event: "begin_review", actorId: "a" }));
    c = ok(
      c.recordApproval({ role: "compliance-officer", approverId: "u1", decision: "approved" }),
    );
    expect(c.version).toBe(3);
  });
});

describe("approval gating", () => {
  function readyToConfirm(): ComplianceCase {
    return ok(openCase("verification-review").transition({ event: "begin_review", actorId: "a" }));
  }

  it("blocks a gated transition with no approvals and names the missing roles", () => {
    const result = readyToConfirm().transition({ event: "confirm", actorId: "a" });
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("compliance-officer");
      expect(result.error.message).toContain("legal-counsel");
    }
  });

  it("tracks partial approval and still blocks", () => {
    const c = ok(
      readyToConfirm().recordApproval({
        role: "compliance-officer",
        approverId: "u1",
        decision: "approved",
      }),
    );
    expect(c.approvalChain.approvedRoles).toEqual(["compliance-officer"]);
    expect(c.approvalChain.pendingRoles).toEqual(["legal-counsel"]);
    const result = c.transition({ event: "confirm", actorId: "a" });
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("legal-counsel");
      expect(result.error.message).not.toContain("compliance-officer");
    }
  });

  it("unlocks the gated transition once every slot is approved", () => {
    const c = approveAll(readyToConfirm());
    expect(c.approvalChain.isSatisfied).toBe(true);
    expect(ok(c.transition({ event: "confirm", actorId: "a" })).state).toBe("confirmed");
  });

  it("does not gate ungated transitions", () => {
    expect(ok(readyToConfirm().transition({ event: "escalate", actorId: "a" })).state).toBe(
      "escalated",
    );
  });

  it("blocks the gated transition permanently after a rejection", () => {
    let c = ok(
      readyToConfirm().recordApproval({
        role: "legal-counsel",
        approverId: "u1",
        decision: "rejected",
        comment: "insufficient evidence",
      }),
    );
    expect(c.approvalChain.isRejected).toBe(true);
    expect(Result.isErr(c.transition({ event: "confirm", actorId: "a" }))).toBe(true);
    // Another approver cannot paper over the rejection.
    const more = c.recordApproval({
      role: "compliance-officer",
      approverId: "u2",
      decision: "approved",
    });
    expect(Result.isErr(more)).toBe(true);
    // The case can still be closed the other way.
    c = ok(c.transition({ event: "dismiss", actorId: "a" }));
    expect(c.state).toBe("dismissed");
  });

  it("gates the data subject request fulfilment the same way", () => {
    let c = openCase("data-subject-request");
    c = ok(c.transition({ event: "verify_identity", actorId: "a" }));
    c = ok(c.transition({ event: "start_fulfilment", actorId: "a" }));
    expect(Result.isErr(c.transition({ event: "fulfil", actorId: "a" }))).toBe(true);
    c = approveAll(c);
    expect(ok(c.transition({ event: "fulfil", actorId: "a" })).state).toBe("fulfilled");
  });

  it("raises an auditable event for approvals and rejections", () => {
    const approved = ok(
      readyToConfirm().recordApproval({
        role: "legal-counsel",
        approverId: "u1",
        decision: "approved",
      }),
    );
    const rejected = ok(
      readyToConfirm().recordApproval({
        role: "legal-counsel",
        approverId: "u1",
        decision: "rejected",
      }),
    );
    expect(approved.pendingEvents).toMatchObject([
      { eventName: "governance.compliance_case.approval_recorded", decision: "approved" },
    ]);
    expect(rejected.pendingEvents).toMatchObject([{ decision: "rejected" }]);
  });

  it("refuses approvals on a closed case", () => {
    const closed = ok(
      openCase("verification-review").transition({ event: "dismiss", actorId: "a" }),
    );
    expect(
      Result.isErr(
        closed.recordApproval({ role: "legal-counsel", approverId: "u", decision: "approved" }),
      ),
    ).toBe(true);
  });
});

describe("ApprovalChain", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("rejects the same approver filling two slots", () => {
    const chain = ApprovalChain.create(["a", "b"]);
    const first = chain.record({
      role: "a",
      approverId: "u1",
      decision: "approved",
      decidedAt: at,
    });
    expect(Result.isOk(first)).toBe(true);
    if (Result.isErr(first)) return;
    const second = first.value.record({
      role: "b",
      approverId: "u1",
      decision: "approved",
      decidedAt: at,
    });
    expect(Result.isErr(second)).toBe(true);
    expect(first.value.isSatisfied).toBe(false);
  });

  it("rejects a second approval for an already-filled slot", () => {
    const first = ok(
      ApprovalChain.create(["a", "b"]).record({
        role: "a",
        approverId: "u1",
        decision: "approved",
        decidedAt: at,
      }),
    );
    expect(
      Result.isErr(
        first.record({ role: "a", approverId: "u2", decision: "approved", decidedAt: at }),
      ),
    ).toBe(true);
  });

  it("rejects a role that is not part of the chain", () => {
    const result = ApprovalChain.create(["a"]).record({
      role: "ghost",
      approverId: "u1",
      decision: "approved",
      decidedAt: at,
    });
    expect(Result.isErr(result)).toBe(true);
  });

  it("is never satisfied when it requires nobody", () => {
    expect(ApprovalChain.create([]).isSatisfied).toBe(false);
  });

  it("does not mutate itself when recording", () => {
    const chain = ApprovalChain.create(["a"]);
    ok(chain.record({ role: "a", approverId: "u1", decision: "approved", decidedAt: at }));
    expect(chain.records).toHaveLength(0);
  });
});
