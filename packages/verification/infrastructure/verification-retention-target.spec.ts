import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import {
  VerificationRequest,
  type VerificationOrganizationId,
  type VerificationRequestId,
  type VerificationSubjectId,
} from "../domain/entities/verification-request.js";
import { VerificationStatus } from "../domain/value-objects/verification-status.js";
import { VerificationType } from "../domain/value-objects/verification-type.js";

import { InMemoryVerificationRetentionStore } from "./testing/in-memory-verification-retention-store.js";
import { VerificationRetentionTarget } from "./verification-retention-target.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const ORG_1 = createId<"VerificationOrganizationId">() as VerificationOrganizationId;
const ORG_2 = createId<"VerificationOrganizationId">() as VerificationOrganizationId;

function request(
  org: VerificationOrganizationId,
  state: { decided: "approved" | "rejected"; daysAgo: number } | { open: "in_review" },
): VerificationRequest {
  const base = {
    id: createId<"VerificationRequestId">() as VerificationRequestId,
    subjectUserId: createId<"VerificationSubjectId">() as VerificationSubjectId,
    organizationId: org,
    type: VerificationType.reconstitute("identity-document"),
    assignment: undefined,
    needsMoreInfoNote: undefined,
    createdAt: daysAgo(500),
    updatedAt: daysAgo(500),
  };
  return "open" in state
    ? VerificationRequest.reconstitute({
        ...base,
        status: VerificationStatus.reconstitute(state.open),
        decision: undefined,
      })
    : VerificationRequest.reconstitute({
        ...base,
        status: VerificationStatus.reconstitute(state.decided),
        decision: {
          decidedBy: createId<"ReviewerId">(),
          decidedAt: daysAgo(state.daysAgo),
          note: "n",
        },
      });
}

function setup(requests: VerificationRequest[]) {
  const store = new InMemoryVerificationRetentionStore(requests);
  return { store, target: new VerificationRetentionTarget(store) };
}

const query = (action: string, org = ORG_1, limit = 100) => ({
  organizationId: org as string,
  action,
  cutoff: daysAgo(30),
  limit,
});

describe("VerificationRetentionTarget", () => {
  it("offers only decided requests past the cutoff, never open work", async () => {
    const oldApproved = request(ORG_1, { decided: "approved", daysAgo: 90 });
    const oldRejected = request(ORG_1, { decided: "rejected", daysAgo: 60 });
    const recent = request(ORG_1, { decided: "approved", daysAgo: 3 });
    const stillOpen = request(ORG_1, { open: "in_review" });
    const { target } = setup([oldApproved, oldRejected, recent, stillOpen]);

    const found = await target.findExpired(query("delete"));

    expect(found.map((f) => f.resourceId)).toEqual([oldApproved.id, oldRejected.id]);
  });

  it("is scoped to the organization", async () => {
    const mine = request(ORG_1, { decided: "approved", daysAgo: 90 });
    const theirs = request(ORG_2, { decided: "approved", daysAgo: 90 });
    const { target, store } = setup([mine, theirs]);

    expect((await target.findExpired(query("delete"))).map((f) => f.resourceId)).toEqual([mine.id]);
    // Acting on another organization's id through this organization changes nothing.
    expect(await target.apply(ORG_1, theirs.id, "delete")).toBe("already_applied");
    expect(store.has(theirs.id)).toBe(true);
  });

  it("deletes, and deleting again is a harmless no-op", async () => {
    const r = request(ORG_1, { decided: "approved", daysAgo: 90 });
    const { target, store } = setup([r]);

    expect(await target.apply(ORG_1, r.id, "delete")).toBe("applied");
    expect(store.has(r.id)).toBe(false);
    expect(await target.apply(ORG_1, r.id, "delete")).toBe("already_applied");
    expect(await target.findExpired(query("delete"))).toEqual([]);
  });

  it("archives in place, stops offering the request, and is idempotent", async () => {
    const r = request(ORG_1, { decided: "rejected", daysAgo: 90 });
    const { target, store } = setup([r]);

    expect(await target.apply(ORG_1, r.id, "archive")).toBe("applied");
    expect(store.has(r.id)).toBe(true);
    expect(store.isArchived(r.id)).toBe(true);
    expect(await target.findExpired(query("archive"))).toEqual([]);
    expect(await target.apply(ORG_1, r.id, "archive")).toBe("already_applied");
  });

  it("returns at most the requested batch, oldest decision first", async () => {
    const a = request(ORG_1, { decided: "approved", daysAgo: 120 });
    const b = request(ORG_1, { decided: "approved", daysAgo: 100 });
    const c = request(ORG_1, { decided: "approved", daysAgo: 80 });
    const { target } = setup([c, a, b]);

    const found = await target.findExpired(query("delete", ORG_1, 2));
    expect(found.map((f) => f.resourceId)).toEqual([a.id, b.id]);
  });

  it("does not support anonymize and says so", async () => {
    const r = request(ORG_1, { decided: "approved", daysAgo: 90 });
    const { target, store } = setup([r]);

    expect(target.supportedActions).toEqual(["delete", "archive"]);
    await expect(target.findExpired(query("anonymize"))).rejects.toThrow(/anonymize/);
    await expect(target.apply(ORG_1, r.id, "anonymize")).rejects.toThrow(/anonymize/);
    expect(store.has(r.id)).toBe(true);
  });
});
