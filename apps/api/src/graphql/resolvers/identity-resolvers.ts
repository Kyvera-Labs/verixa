import { asId, Result } from "@verixa/shared-kernel";
import type { Organization, OrganizationId, User, UserId } from "@verixa/identity";

import type { Container } from "../../composition-root.js";

/**
 * GraphQL presentation shape for a User.
 */
export interface GraphQLUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * GraphQL presentation shape for an Organization.
 */
export interface GraphQLOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Maps a domain `User` entity to the GraphQL presentation shape.
 */
export function toGraphQLUser(user: User): GraphQLUser {
  return {
    id: user.id,
    email: user.email.value,
    displayName: user.displayName.value,
    givenName: user.personName?.givenName ?? null,
    familyName: user.personName?.familyName ?? null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

/**
 * Maps a domain `Organization` entity to the GraphQL presentation shape.
 */
export function toGraphQLOrganization(org: Organization): GraphQLOrganization {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    ownerId: org.ownerId,
    status: org.status,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

/**
 * Creates field-level GraphQL resolvers for Identity & Organization types.
 *
 * Resolvers do NOT access repositories or persistence directly: every read
 * delegates to an application use case on the container, preserving the
 * hexagonal architecture boundary.
 */
export function createIdentityResolvers(container: Container) {
  return {
    Query: {
      user: async (_parent: unknown, args: { id: string }): Promise<GraphQLUser | null> => {
        const result = await container.identity.getUser.execute({
          id: asId<"UserId">(args.id),
        });
        if (!Result.isOk(result) || !result.value) {
          return null;
        }
        return toGraphQLUser(result.value);
      },

      organization: async (
        _parent: unknown,
        args: { id: string },
      ): Promise<GraphQLOrganization | null> => {
        const result = await container.identity.getOrganization.execute({
          id: asId<"OrganizationId">(args.id),
        });
        if (!Result.isOk(result) || !result.value) {
          return null;
        }
        return toGraphQLOrganization(result.value);
      },

      organizationBySlug: async (
        _parent: unknown,
        args: { slug: string },
      ): Promise<GraphQLOrganization | null> => {
        const result = await container.identity.getOrganization.execute({
          slug: args.slug,
        });
        if (!Result.isOk(result) || !result.value) {
          return null;
        }
        return toGraphQLOrganization(result.value);
      },

      organizations: async (): Promise<GraphQLOrganization[]> => {
        const result = await container.identity.listOrganizations.execute();
        if (!Result.isOk(result)) {
          return [];
        }
        return result.value.map(toGraphQLOrganization);
      },
    },

    Organization: {
      owner: async (parent: GraphQLOrganization): Promise<GraphQLUser | null> => {
        const result = await container.identity.getUser.execute({
          id: asId<"UserId">(parent.ownerId),
        });
        if (!Result.isOk(result) || !result.value) {
          return null;
        }
        return toGraphQLUser(result.value);
      },

      users: async (parent: GraphQLOrganization): Promise<GraphQLUser[]> => {
        const result = await container.identity.getOrganizationUsers.execute({
          organizationId: asId<"OrganizationId">(parent.id),
        });
        if (!Result.isOk(result)) {
          return [];
        }
        return result.value.map(toGraphQLUser);
      },
    },

    User: {
      organizations: async (parent: GraphQLUser): Promise<GraphQLOrganization[]> => {
        const result = await container.identity.getUserOrganizations.execute({
          userId: asId<"UserId">(parent.id),
        });
        if (!Result.isOk(result)) {
          return [];
        }
        return result.value.map(toGraphQLOrganization);
      },
    },
  };
}

/**
 * Creates Mercurius loaders for batching relational lookups across query AST nodes.
 *
 * This systematic batching eliminates N+1 queries when requesting nested fields
 * across multiple organizations in one query round trip.
 */
export function createIdentityLoaders(container: Container) {
  return {
    Organization: {
      users: async (queries: Array<{ obj: GraphQLOrganization }>): Promise<GraphQLUser[][]> => {
        const orgIds = queries.map((q) => asId<"OrganizationId">(q.obj.id));
        const result = await container.identity.getUsersByOrganizationIds.execute({
          organizationIds: orgIds,
        });
        const map = Result.isOk(result) ? result.value : new Map<OrganizationId, User[]>();

        return queries.map((q) => {
          const users = map.get(asId<"OrganizationId">(q.obj.id)) ?? [];
          return users.map(toGraphQLUser);
        });
      },
    },
  };
}
