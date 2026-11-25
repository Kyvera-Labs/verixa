import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationMembership,
  type OrganizationId,
  type UserId,
} from "../../domain/organization-membership.js";

import {
  AddMember,
  ChangeMemberRole,
  RemoveMember,
  type MembershipRepository,
} from "./manage-membership.js";

class InMemoryMemberships implements MembershipRepository {
  readonly rows = new Map<string, OrganizationMembership>();
  private key(o: OrganizationId, u: UserId): string {
    return `${o}:${u}`;
  }
  find(o: OrganizationId, u: UserId): Promise<OrganizationMembership | null> {
    return Promise.resolve(this.rows.get(this.key(o, u)) ?? null);
  }
  countOwners(o: OrganizationId): Promise<number> {
    const owners = [...this.rows.values()].filter(
      (m) => m.organizationId === o && m.role === "owner" && m.active,
    );
    return Promise.resolve(owners.length);
  }
  save(m: OrganizationMembership): Promise<void> {
    this.rows.set(this.key(m.organizationId, m.userId), m);
    return Promise.resolve();
  }
}

const organizationId = asId<"OrganizationId">("org_1");
const alice = asId<"UserId">("alice");
const bob = asId<"UserId">("bob");

describe("membership use cases", () => {
  let repo: InMemoryMemberships;

  beforeEach(async () => {
    repo = new InMemoryMemberships();
    await repo.save(
      OrganizationMembership.create({ organizationId, userId: alice, role: "owner" }),
    );
  });

  it("adds a member when an admin asks", async () => {
    const result = await new AddMember(repo).execute({
      organizationId,
      userId: bob,
      role: "member",
      actorRole: "admin",
    });
    expect(Result.isOk(result)).toBe(true);
    expect(await repo.find(organizationId, bob)).not.toBeNull();
  });

  it("refuses to let a plain member add anyone", async () => {
    const result = await new AddMember(repo).execute({
      organizationId,
      userId: bob,
      role: "member",
      actorRole: "member",
    });
    expect(Result.isErr(result)).toBe(true);
    expect(await repo.find(organizationId, bob)).toBeNull();
  });

  it("refuses to let an admin add an owner (privilege escalation)", async () => {
    const result = await new AddMember(repo).execute({
      organizationId,
      userId: bob,
      role: "owner",
      actorRole: "admin",
    });
    expect(Result.isErr(result)).toBe(true);
    expect(await repo.find(organizationId, bob)).toBeNull();
  });

  it("lets an owner add another owner", async () => {
    const result = await new AddMember(repo).execute({
      organizationId,
      userId: bob,
      role: "owner",
      actorRole: "owner",
    });
    expect(Result.isOk(result)).toBe(true);
  });

  it("will not remove or demote the last owner", async () => {
    const removed = await new RemoveMember(repo).execute({
      organizationId,
      userId: alice,
      actorRole: "owner",
    });
    const demoted = await new ChangeMemberRole(repo).execute({
      organizationId,
      userId: alice,
      role: "admin",
      actorRole: "owner",
    });
    expect(Result.isErr(removed)).toBe(true);
    expect(Result.isErr(demoted)).toBe(true);
    expect((await repo.find(organizationId, alice))?.role).toBe("owner");
  });

  it("changes a role and persists it", async () => {
    await repo.save(OrganizationMembership.create({ organizationId, userId: bob, role: "member" }));
    const result = await new ChangeMemberRole(repo).execute({
      organizationId,
      userId: bob,
      role: "admin",
      actorRole: "owner",
    });
    expect(Result.isOk(result)).toBe(true);
    expect((await repo.find(organizationId, bob))?.role).toBe("admin");
  });

  it("reports a missing membership", async () => {
    const result = await new RemoveMember(repo).execute({
      organizationId,
      userId: bob,
      actorRole: "owner",
    });
    expect(Result.isErr(result)).toBe(true);
  });
});
