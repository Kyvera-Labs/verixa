import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type { AuthorizationRepository } from "../application/authorization-repository.js";
import { AuthorizationError } from "../domain/authorization.js";

interface RoleParams {
  roleId: string;
}
interface UserParams {
  userId: string;
}
interface RoleQuery {
  organizationId?: string;
}
interface CreateRoleBody {
  name: string;
  description: string;
}
interface UpdateRoleBody {
  name?: string;
  description?: string;
}
interface PermissionBody {
  key: string;
}
interface AssignmentBody {
  roleId: string;
  organizationId?: string;
  expiresAt?: string;
}

function header(
  request: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorStatus(error: unknown): number {
  if (!(error instanceof AuthorizationError)) return 500;
  return error.code === "NOT_FOUND"
    ? 404
    : error.code === "CONFLICT"
      ? 409
      : error.code === "INVALID"
        ? 400
        : 403;
}

function replyError(
  reply: { code: (status: number) => { send: (body: object) => unknown } },
  error: unknown,
): unknown {
  const status = errorStatus(error);
  return reply.code(status).send({
    error:
      status === 403
        ? "Forbidden"
        : error instanceof Error
          ? error.message
          : "Internal server error",
  });
}

const roleParamsSchema = {
  $id: "AdminRoleParams",
  type: "object",
  required: ["roleId"],
  additionalProperties: false,
  properties: { roleId: { type: "string", minLength: 1 } },
} as const;
const userParamsSchema = {
  $id: "AdminUserParams",
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: { userId: { type: "string", minLength: 1 } },
} as const;
const assignmentParamsSchema = {
  $id: "AdminAssignmentParams",
  type: "object",
  required: ["assignmentId"],
  additionalProperties: false,
  properties: { assignmentId: { type: "string", minLength: 1 } },
} as const;
const createRoleBodySchema = {
  $id: "AdminCreateRoleBody",
  type: "object",
  required: ["name", "description"],
  additionalProperties: false,
  properties: { name: { type: "string" }, description: { type: "string" } },
} as const;
const updateRoleBodySchema = {
  $id: "AdminUpdateRoleBody",
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: { name: { type: "string" }, description: { type: "string" } },
} as const;
const permissionBodySchema = {
  $id: "AdminPermissionBody",
  type: "object",
  required: ["key"],
  additionalProperties: false,
  properties: { key: { type: "string", minLength: 1 } },
} as const;
const assignmentBodySchema = {
  $id: "AdminAssignmentBody",
  type: "object",
  required: ["roleId"],
  additionalProperties: false,
  properties: {
    roleId: { type: "string", minLength: 1 },
    organizationId: { type: "string", minLength: 1 },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
const assignmentQuerySchema = {
  $id: "AdminAssignmentQuery",
  type: "object",
  additionalProperties: false,
  properties: { organizationId: { type: "string", minLength: 1 } },
} as const;

const ADMIN_SCHEMAS = [
  roleParamsSchema,
  userParamsSchema,
  assignmentParamsSchema,
  createRoleBodySchema,
  updateRoleBodySchema,
  permissionBodySchema,
  assignmentBodySchema,
  assignmentQuerySchema,
] as const;

const roleParamsRef = { $ref: "AdminRoleParams#" } as const;
const userParamsRef = { $ref: "AdminUserParams#" } as const;
const assignmentParamsRef = { $ref: "AdminAssignmentParams#" } as const;
const createRoleBodyRef = { $ref: "AdminCreateRoleBody#" } as const;
const updateRoleBodyRef = { $ref: "AdminUpdateRoleBody#" } as const;
const permissionBodyRef = { $ref: "AdminPermissionBody#" } as const;
const assignmentBodyRef = { $ref: "AdminAssignmentBody#" } as const;
const assignmentQueryRef = { $ref: "AdminAssignmentQuery#" } as const;

/** Registers the complete RBAC management surface. Authentication is supplied
 * by the session layer through x-user-id until the principal plugin lands. */
export function registerAdminAuthorizationRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  authorization: AuthorizationRepository,
): void {
  for (const schema of ADMIN_SCHEMAS) {
    if (app.getSchema(schema.$id) === undefined) {
      app.addSchema(schema);
    }
  }

  const requirePermission = async (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (status: number) => { send: (body: object) => unknown } },
    permission: string,
  ): Promise<boolean> => {
    const userId = header(request, "x-user-id");
    if (
      userId === undefined ||
      !(await authorization.hasPermission(
        userId,
        header(request, "x-organization-id") ?? null,
        permission,
      ))
    ) {
      reply.code(403).send({ error: "Forbidden" });
      return false;
    }
    return true;
  };

  app.get("/roles", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:read"))) return;
    return authorization.listRoles();
  });
  app.post<{ Body: CreateRoleBody }>(
    "/roles",
    { schema: { body: createRoleBodyRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      if (request.body.name.trim() === "" || request.body.description.trim() === "") {
        return reply.code(400).send({ error: "name and description are required" });
      }
      try {
        const role = await authorization.createRole({
          ...request.body,
          isSystemRole: false,
        });
        return reply.code(201).send(role);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.patch<{ Params: RoleParams; Body: UpdateRoleBody }>(
    "/roles/:roleId",
    { schema: { params: roleParamsRef, body: updateRoleBodyRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.updateRole(request.params.roleId, request.body);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.delete<{ Params: RoleParams }>(
    "/roles/:roleId",
    { schema: { params: roleParamsRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        await authorization.deleteRole(request.params.roleId);
        return reply.code(204).send();
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.get("/permissions", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:read"))) return;
    return authorization.listPermissions();
  });
  app.post<{ Params: RoleParams; Body: PermissionBody }>(
    "/roles/:roleId/permissions",
    { schema: { params: roleParamsRef, body: permissionBodyRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.grantPermission(request.params.roleId, request.body.key);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.delete<{ Params: RoleParams; Body: PermissionBody }>(
    "/roles/:roleId/permissions",
    { schema: { params: roleParamsRef, body: permissionBodyRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.revokePermission(request.params.roleId, request.body.key);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.get<{ Params: UserParams; Querystring: RoleQuery }>(
    "/users/:userId/roles",
    { schema: { params: userParamsRef, querystring: assignmentQueryRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:read"))) return;
      const callerOrganizationId = header(request, "x-organization-id");
      if (
        callerOrganizationId === undefined ||
        (request.query.organizationId !== undefined &&
          request.query.organizationId !== callerOrganizationId)
      ) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      return authorization.listAssignments(request.params.userId, callerOrganizationId);
    },
  );
  app.post<{ Params: UserParams; Body: AssignmentBody }>(
    "/users/:userId/roles",
    { schema: { params: userParamsRef, body: assignmentBodyRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        const actorId = header(request, "x-user-id");
        const callerOrganizationId = header(request, "x-organization-id");
        const organizationId = request.body.organizationId ?? callerOrganizationId;
        if (organizationId === undefined || organizationId !== callerOrganizationId) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        const targetRole = await authorization.getRole(request.body.roleId);
        if (targetRole === undefined) return reply.code(404).send({ error: "Role not found" });
        if (actorId !== undefined && actorId === request.params.userId) {
          const canGrant = await Promise.all(
            targetRole.permissions.map((permission) =>
              authorization.hasPermission(
                actorId,
                header(request, "x-organization-id") ?? null,
                permission,
              ),
            ),
          );
          if (!canGrant.every(Boolean)) return reply.code(403).send({ error: "Forbidden" });
        }
        const assignment = await authorization.assignRole({
          userId: request.params.userId,
          roleId: request.body.roleId,
          organizationId,
          assignedBy: header(request, "x-user-id") ?? null,
          expiresAt: request.body.expiresAt === undefined ? null : new Date(request.body.expiresAt),
        });
        return reply.code(201).send(assignment);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
  app.delete<{ Params: { assignmentId: string } }>(
    "/user-role-assignments/:assignmentId",
    { schema: { params: assignmentParamsRef } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        await authorization.revokeAssignment(request.params.assignmentId);
        return reply.code(204).send();
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
}
