import { createGraphQLApp } from "@verixa/api/app";
import type { Container } from "@verixa/api/composition-root";
import {
  User,
  DisplayName,
  Email,
  Organization,
  OrganizationMembership,
  InMemoryOrganizationMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUserRepository,
  GetOrganization,
  GetOrganizationUsers,
  GetUser,
  GetUserOrganizations,
  GetUsersByOrganizationIds,
  ListOrganizations,
} from "@verixa/identity";
import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error(`Failed to unwrap Result: ${JSON.stringify(result)}`);
  }
  return result.value;
}

interface GqlResponse {
  data: Record<string, Record<string, unknown>>;
  errors?: unknown[];
}

function createMockContainer(overrides?: {
  users?: InMemoryUserRepository;
  organizations?: InMemoryOrganizationRepository;
  memberships?: InMemoryOrganizationMembershipRepository;
}): {
  container: Container;
  userRepo: InMemoryUserRepository;
  orgRepo: InMemoryOrganizationRepository;
  membershipRepo: InMemoryOrganizationMembershipRepository;
} {
  const userRepo = overrides?.users ?? new InMemoryUserRepository();
  const orgRepo = overrides?.organizations ?? new InMemoryOrganizationRepository();
  const membershipRepo = overrides?.memberships ?? new InMemoryOrganizationMembershipRepository();

  const getUser = new GetUser(userRepo);
  const getOrganization = new GetOrganization(orgRepo);
  const getOrganizationUsers = new GetOrganizationUsers(membershipRepo, userRepo);
  const getUserOrganizations = new GetUserOrganizations(membershipRepo, orgRepo);
  const getUsersByOrganizationIds = new GetUsersByOrganizationIds(membershipRepo, userRepo);
  const listOrganizations = new ListOrganizations(orgRepo);

  const container = {
    identity: {
      getUser,
      getOrganization,
      getOrganizationUsers,
      getUserOrganizations,
      getUsersByOrganizationIds,
      listOrganizations,
    },
  } as unknown as Container;

  return { container, userRepo, orgRepo, membershipRepo };
}

describe("GraphQL Identity & Organization Types (Issue 243 / Roadmap 184)", () => {
  it("queries a single user by ID", async () => {
    const { container, userRepo } = createMockContainer();
    const user = User.register({
      email: unwrap(Email.create("alice@example.com")),
      displayName: unwrap(DisplayName.create("Alice Developer")),
    });
    await userRepo.save(user);

    const app = await createGraphQLApp({ container });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetUser($id: ID!) {
            user(id: $id) {
              id
              email
              displayName
              status
            }
          }
        `,
        variables: { id: user.id },
      },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<GqlResponse>();
    expect(body.errors).toBeUndefined();
    expect(body.data.user).toEqual({
      id: user.id,
      email: "alice@example.com",
      displayName: "Alice Developer",
      status: "pending",
    });

    await app.close();
  });

  it("queries an organization by ID and slug", async () => {
    const { container, orgRepo } = createMockContainer();
    const ownerId = asId<"UserId">("00000000-0000-0000-0000-000000000001");
    const org = unwrap(
      Organization.create({
        name: "Acme Corp",
        slug: "acme",
        ownerId,
      }),
    );
    await orgRepo.save(org);

    const app = await createGraphQLApp({ container });
    await app.ready();

    // Query by ID
    const resById = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetOrg($id: ID!) {
            organization(id: $id) {
              id
              name
              slug
              status
            }
          }
        `,
        variables: { id: org.id },
      },
      headers: { "content-type": "application/json" },
    });
    expect(resById.statusCode).toBe(200);
    expect(resById.json<GqlResponse>().data.organization).toEqual({
      id: org.id,
      name: "Acme Corp",
      slug: "acme",
      status: "active",
    });

    // Query by Slug
    const resBySlug = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetOrgBySlug($slug: String!) {
            organizationBySlug(slug: $slug) {
              id
              name
              slug
              status
            }
          }
        `,
        variables: { slug: "acme" },
      },
      headers: { "content-type": "application/json" },
    });
    expect(resBySlug.statusCode).toBe(200);
    expect(resBySlug.json<GqlResponse>().data.organizationBySlug).toEqual({
      id: org.id,
      name: "Acme Corp",
      slug: "acme",
      status: "active",
    });

    await app.close();
  });

  it("resolves nested Organization.owner relationship", async () => {
    const { container, userRepo, orgRepo } = createMockContainer();
    const owner = User.register({
      email: unwrap(Email.create("owner@example.com")),
      displayName: unwrap(DisplayName.create("Owner User")),
    });
    await userRepo.save(owner);

    const org = unwrap(
      Organization.create({
        name: "Acme Corp",
        slug: "acme",
        ownerId: owner.id,
      }),
    );
    await orgRepo.save(org);

    const app = await createGraphQLApp({ container });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetOrgOwner($id: ID!) {
            organization(id: $id) {
              id
              name
              owner {
                id
                email
                displayName
              }
            }
          }
        `,
        variables: { id: org.id },
      },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GqlResponse>().data.organization?.owner).toEqual({
      id: owner.id,
      email: "owner@example.com",
      displayName: "Owner User",
    });

    await app.close();
  });

  it("resolves nested User.organizations relationship", async () => {
    const { container, userRepo, orgRepo, membershipRepo } = createMockContainer();
    const user = User.register({
      email: unwrap(Email.create("bob@example.com")),
      displayName: unwrap(DisplayName.create("Bob")),
    });
    await userRepo.save(user);

    const org1 = unwrap(
      Organization.create({
        name: "Org 1",
        slug: "org-1",
        ownerId: user.id,
      }),
    );
    const org2 = unwrap(
      Organization.create({
        name: "Org 2",
        slug: "org-2",
        ownerId: user.id,
      }),
    );
    await orgRepo.save(org1);
    await orgRepo.save(org2);

    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: user.id, organizationId: org1.id })),
    );
    await membershipRepo.save(
      unwrap(OrganizationMembership.create({ userId: user.id, organizationId: org2.id })),
    );

    const app = await createGraphQLApp({ container });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetUserOrgs($id: ID!) {
            user(id: $id) {
              id
              organizations {
                id
                name
                slug
              }
            }
          }
        `,
        variables: { id: user.id },
      },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GqlResponse>().data.user?.organizations).toHaveLength(2);

    await app.close();
  });

  it("resolves nested Organization.users without N+1 query regression", async () => {
    const { container, userRepo, orgRepo, membershipRepo } = createMockContainer();

    const ownerId = asId<"UserId">("00000000-0000-0000-0000-000000000001");
    const org = unwrap(
      Organization.create({
        name: "Multi-User Org",
        slug: "multi-user",
        ownerId,
      }),
    );
    await orgRepo.save(org);

    // Create 5 member users
    const users: User[] = [];
    for (let i = 1; i <= 5; i++) {
      const u = User.register({
        email: unwrap(Email.create(`member${i}@example.com`)),
        displayName: unwrap(DisplayName.create(`Member ${i}`)),
      });
      await userRepo.save(u);
      await membershipRepo.save(
        unwrap(
          OrganizationMembership.create({
            userId: u.id,
            organizationId: org.id,
          }),
        ),
      );
      users.push(u);
    }

    // Spy on repository query methods to assert N+1 prevention
    const findByIdSpy = vi.spyOn(userRepo, "findById");
    const findManyByIdsSpy = vi.spyOn(userRepo, "findManyByIds");
    const findAllByOrgIdsSpy = vi.spyOn(membershipRepo, "findAllByOrganizationIds");
    const findAllByOrgSpy = vi.spyOn(membershipRepo, "findAllByOrganization");

    const app = await createGraphQLApp({ container });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `
          query GetOrgUsers($id: ID!) {
            organization(id: $id) {
              id
              name
              users {
                id
                email
                displayName
              }
            }
          }
        `,
        variables: { id: org.id },
      },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<GqlResponse>().data;
    expect(data.organization?.users).toHaveLength(5);

    // N+1 VERIFICATION:
    // 1. Memberships are retrieved in exactly 1 batched call for the organization.
    const membershipCalls =
      findAllByOrgIdsSpy.mock.calls.length + findAllByOrgSpy.mock.calls.length;
    expect(membershipCalls).toBe(1);

    // 2. Users are retrieved in exactly 1 batch call (findManyByIds), NOT 5 separate findById calls!
    expect(findManyByIdsSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).not.toHaveBeenCalled();

    // 3. The batch query received all 5 user IDs in one array
    const batchedIds = findManyByIdsSpy.mock.calls[0]![0];
    expect(batchedIds).toHaveLength(5);

    await app.close();
  });
});
