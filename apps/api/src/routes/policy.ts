import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import { sendApiError, sendError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";

import {
  createPolicyBodyZod,
  policyOrganizationParamsZod,
  policyParamsZod,
  policyVersionsQueryZod,
  updatePolicyBodyZod,
  type CreatePolicyBody,
  type PolicyOrganizationParams,
  type PolicyParams,
  type PolicyVersionsQuery,
  type UpdatePolicyBody,
} from "./schemas/policy-schemas.js";

export interface PolicyDto {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly ruleset: Readonly<Record<string, unknown>>;
  readonly status: "draft" | "published" | "archived";
  readonly version: number;
}

export interface PolicyVersionDto {
  readonly version: number;
  readonly ruleset: Readonly<Record<string, unknown>>;
  readonly publishedAt: string;
}

export interface PolicyPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** The transport-facing seam for the governance application layer. */
export interface PolicyManagementUseCases {
  create(input: {
    organizationId: string;
    name: string;
    ruleset: Readonly<Record<string, unknown>>;
  }): Promise<PolicyDto>;
  list(input: {
    organizationId: string;
    cursor?: string;
    limit: number;
  }): Promise<PolicyPage<PolicyDto>>;
  update(input: {
    organizationId: string;
    policyId: string;
    name?: string;
    ruleset?: Readonly<Record<string, unknown>>;
  }): Promise<PolicyDto | null>;
  publish(input: { organizationId: string; policyId: string }): Promise<PolicyDto | null>;
  versions(input: {
    organizationId: string;
    policyId: string;
    cursor?: string;
    limit: number;
  }): Promise<PolicyPage<PolicyVersionDto> | null>;
}

export interface PolicyAuthorization {
  hasPermission(userId: string, organizationId: string, permission: string): Promise<boolean>;
}

export interface PolicyRouteDependencies {
  readonly policies: PolicyManagementUseCases;
  readonly authorization: PolicyAuthorization;
}

type App<TLogger extends FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  TLogger
>;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function requireOrgPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  params: { orgId: string },
  authorization: PolicyAuthorization,
  permission: string,
): Promise<boolean> {
  const userId = header(request, "x-user-id");
  const callerOrgId = header(request, "x-organization-id");
  if (userId === undefined || callerOrgId === undefined) {
    sendApiError(reply, "FORBIDDEN", "Permission denied.");
    return false;
  }
  // A mismatched tenant is intentionally indistinguishable from a missing
  // policy. This prevents an org admin from enumerating another org's data.
  if (callerOrgId !== params.orgId) {
    sendApiError(reply, "NOT_FOUND", "Policy not found.");
    return false;
  }
  if (!(await authorization.hasPermission(userId, params.orgId, permission))) {
    sendApiError(reply, "FORBIDDEN", "Permission denied.");
    return false;
  }
  return true;
}

function notFound(reply: FastifyReply): void {
  sendApiError(reply, "NOT_FOUND", "Policy not found.");
}

export function registerPolicyRoutes<TLogger extends FastifyBaseLogger>(
  app: App<TLogger>,
  dependencies: PolicyRouteDependencies,
): void {
  const organizationParams = registerZodSchema(
    app,
    "PolicyOrganizationParams",
    policyOrganizationParamsZod,
  );
  const policyParams = registerZodSchema(app, "PolicyParams", policyParamsZod);
  const createBody = registerZodSchema(app, "CreatePolicyBody", createPolicyBodyZod);
  const updateBody = registerZodSchema(app, "UpdatePolicyBody", updatePolicyBodyZod);
  const versionsQuery = registerZodSchema(app, "PolicyVersionsQuery", policyVersionsQueryZod);

  app.post<{ Params: PolicyOrganizationParams; Body: CreatePolicyBody }>(
    "/organizations/:orgId/policies",
    { schema: { params: organizationParams, body: createBody, tags: ["Governance"] } },
    async (request, reply) => {
      if (
        !(await requireOrgPermission(
          request,
          reply,
          request.params,
          dependencies.authorization,
          "policies:write",
        ))
      )
        return;
      try {
        const policy = await dependencies.policies.create({
          organizationId: request.params.orgId,
          ...request.body,
        });
        return reply.code(201).send(policy);
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.get<{ Params: PolicyOrganizationParams; Querystring: PolicyVersionsQuery }>(
    "/organizations/:orgId/policies",
    { schema: { params: organizationParams, querystring: versionsQuery, tags: ["Governance"] } },
    async (request, reply) => {
      if (
        !(await requireOrgPermission(
          request,
          reply,
          request.params,
          dependencies.authorization,
          "policies:read",
        ))
      )
        return;
      return reply.send(
        await dependencies.policies.list({
          organizationId: request.params.orgId,
          limit: request.query.limit,
          ...(request.query.cursor !== undefined && { cursor: request.query.cursor }),
        }),
      );
    },
  );

  app.patch<{ Params: PolicyParams; Body: UpdatePolicyBody }>(
    "/organizations/:orgId/policies/:policyId",
    { schema: { params: policyParams, body: updateBody, tags: ["Governance"] } },
    async (request, reply) => {
      if (
        !(await requireOrgPermission(
          request,
          reply,
          request.params,
          dependencies.authorization,
          "policies:write",
        ))
      )
        return;
      try {
        const policy = await dependencies.policies.update({
          organizationId: request.params.orgId,
          policyId: request.params.policyId,
          ...(request.body.name !== undefined && { name: request.body.name }),
          ...(request.body.ruleset !== undefined && { ruleset: request.body.ruleset }),
        });
        if (policy === null) return notFound(reply);
        return reply.send(policy);
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Params: PolicyParams }>(
    "/organizations/:orgId/policies/:policyId/publish",
    { schema: { params: policyParams, tags: ["Governance"] } },
    async (request, reply) => {
      if (
        !(await requireOrgPermission(
          request,
          reply,
          request.params,
          dependencies.authorization,
          "policies:write",
        ))
      )
        return;
      try {
        const policy = await dependencies.policies.publish({
          organizationId: request.params.orgId,
          policyId: request.params.policyId,
        });
        if (policy === null) return notFound(reply);
        // The application layer returns an already-published policy unchanged;
        // this route therefore remains safe to retry without creating a version.
        return reply.send(policy);
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.get<{ Params: PolicyParams; Querystring: PolicyVersionsQuery }>(
    "/organizations/:orgId/policies/:policyId/versions",
    { schema: { params: policyParams, querystring: versionsQuery, tags: ["Governance"] } },
    async (request, reply) => {
      if (
        !(await requireOrgPermission(
          request,
          reply,
          request.params,
          dependencies.authorization,
          "policies:read",
        ))
      )
        return;
      const page = await dependencies.policies.versions({
        organizationId: request.params.orgId,
        policyId: request.params.policyId,
        limit: request.query.limit,
        ...(request.query.cursor !== undefined && { cursor: request.query.cursor }),
      });
      if (page === null) return notFound(reply);
      return reply.send(page);
    },
  );
}
