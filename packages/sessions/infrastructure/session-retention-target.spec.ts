import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../domain/entities/session.js";

import { SessionRetentionTarget } from "./session-retention-target.js";
import { InMemorySessionRetentionStore } from "./testing/in-memory-session-retention-store.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const alice = createId<"UserId">() as SessionUserId;
const bob = createId<"UserId">() as SessionUserId;
const outsider = createId<"UserId">() as SessionUserId;
const members: Record<string, readonly string[]> = { org_1: [alice, bob], org_2: [outsider] };

function session(
  userId: SessionUserId,
  opts: { expiresDaysAgo?: number; expiresInDays?: number; revokedDaysAgo?: number },
): Session {
  const expiresAt =
    opts.expiresInDays === undefined
      ? daysAgo(opts.expiresDaysAgo ?? 0)
      : new Date(NOW.getTime() + opts.expiresInDays * DAY);
  return Session.reconstitute({
    id: createId<"SessionId">(),
    userId,
    createdAt: daysAgo(400),
    lastSeenAt: daysAgo(400),
    expiresAt,
    ipAddress: "203.0.113.9",
    userAgent: "test",
    revokedAt: opts.revokedDaysAgo === undefined ? undefined : daysAgo(opts.revokedDaysAgo),
  });
}

function setup(sessions: Session[]) {
  const store = new InMemorySessionRetentionStore(sessions);
  const target = new SessionRetentionTarget(store, (org) => Promise.resolve(members[org] ?? []));
  return { store, target };
}

const query = (action: string, over: { limit?: number } = {}) => ({
  organizationId: "org_1",
  action,
  cutoff: daysAgo(30),
  limit: over.limit ?? 100,
});

describe("SessionRetentionTarget", () => {
  it("offers sessions that ended before the cutoff, and never live ones", async () => {
    const expired = session(alice, { expiresDaysAgo: 60 });
    const revoked = session(bob, { expiresInDays: 10, revokedDaysAgo: 45 });
    const live = session(alice, { expiresInDays: 10 });
    const recentlyEnded = session(alice, { expiresDaysAgo: 5 });
    const { target } = setup([expired, revoked, live, recentlyEnded]);

    const found = await target.findExpired(query("delete"));

    expect(found.map((f) => f.resourceId).sort()).toEqual([expired.id, revoked.id].sort());
  });

  it("is scoped to the organization's members", async () => {
    const mine = session(alice, { expiresDaysAgo: 60 });
    const theirs = session(outsider, { expiresDaysAgo: 60 });
    const { target, store } = setup([mine, theirs]);

    const found = await target.findExpired(query("delete"));
    expect(found.map((f) => f.resourceId)).toEqual([mine.id]);

    // And it will not act on another organization's session even if asked by id.
    await expect(target.apply("org_1", theirs.id, "delete")).rejects.toThrow(/organization/);
    expect(store.has(theirs.id)).toBe(true);
  });

  it("deletes, and deleting again is a harmless no-op", async () => {
    const s = session(alice, { expiresDaysAgo: 60 });
    const { target, store } = setup([s]);

    expect(await target.apply("org_1", s.id, "delete")).toBe("applied");
    expect(store.has(s.id)).toBe(false);
    expect(await target.apply("org_1", s.id, "delete")).toBe("already_applied");
    expect(await target.findExpired(query("delete"))).toEqual([]);
  });

  it("anonymizes in place, stops offering the session, and is idempotent", async () => {
    const s = session(alice, { expiresDaysAgo: 60 });
    const { target, store } = setup([s]);

    expect(await target.apply("org_1", s.id, "anonymize")).toBe("applied");
    expect(store.has(s.id)).toBe(true);
    expect(store.isAnonymized(s.id)).toBe(true);
    expect(await target.findExpired(query("anonymize"))).toEqual([]);
    expect(await target.apply("org_1", s.id, "anonymize")).toBe("already_applied");
    // An anonymized row is still a candidate for deletion later.
    expect(await target.findExpired(query("delete"))).toHaveLength(1);
  });

  it("returns at most the requested batch, oldest first", async () => {
    const a = session(alice, { expiresDaysAgo: 90 });
    const b = session(alice, { expiresDaysAgo: 80 });
    const c = session(alice, { expiresDaysAgo: 70 });
    const { target } = setup([c, a, b]);

    const found = await target.findExpired(query("delete", { limit: 2 }));
    expect(found.map((f) => f.resourceId)).toEqual([a.id, b.id]);
  });

  it("does not support archive and says so rather than doing something else", async () => {
    const s = session(alice, { expiresDaysAgo: 60 });
    const { target, store } = setup([s]);

    expect(target.supportedActions).toEqual(["delete", "anonymize"]);
    await expect(target.findExpired(query("archive"))).rejects.toThrow(/archive/);
    await expect(target.apply("org_1", s.id, "archive")).rejects.toThrow(/archive/);
    expect(store.has(s.id)).toBe(true);
  });

  it("offers nothing for an organization with no members", async () => {
    const { target } = setup([session(alice, { expiresDaysAgo: 60 })]);
    expect(await target.findExpired({ ...query("delete"), organizationId: "org_empty" })).toEqual(
      [],
    );
  });
});
