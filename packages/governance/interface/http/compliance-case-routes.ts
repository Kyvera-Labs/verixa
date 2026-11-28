import { Result, type DomainError } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type {
  GetComplianceCase,
  ListComplianceCases,
  OpenComplianceCase,
  RecordComplianceApproval,
  TransitionComplianceCase,
} from "../../application/use-cases/compliance-case-use-cases.js";
import type { ComplianceCase } from "../../domain/compliance-case.js";
import type { WorkflowType } from "../../domain/workflow-definitions.js";

import {
  COMPLIANCE_CASE_SCHEMAS,
  approvalBodySchema,
  caseParamsSchema,
  createCaseBodySchema,
  listCasesQuerySchema,
  orgParamsSchema,
  transitionBodySchema,
} from "./schemas/compliance-case-schemas.js";

export const COMPLIANCE_CASE_PERMISSIONS = {
  read: "compliance-cases:read",
  write: "compliance-cases:write",
  approve: "compliance-cases:approve",
} as const;

export interface PermissionCheck {
  hasPermission(userId: string, organizationId: string, permission: string): Promise<boolean>;
}

export interface ComplianceCaseRouteDependencies {
  readonly openCase: OpenComplianceCase;
  readonly getCase: GetComplianceCase;
  readonly listCases: ListComplianceCases;
  readonly transitionCase: TransitionComplianceCase;
  readonly recordApproval: RecordComplianceApproval;
  readonly permissions: PermissionCheck;
}

const FORBIDDEN_BODY = {
  error: {
    code: "FORBIDDEN",
    message: "You do not have permission to perform this action.",
  },
} as const;

function toResponse(c: ComplianceCase) {
  return {
    id: c.id,
    organizationId: c.organizationId,
    workflowType: c.workflowType,
    title: c.title,
    state: c.state,
    assigneeId: c.assigneeId,
    availableEvents: c.availableEvents,
    approvals: {
      requiredRoles: c.approvalChain.requiredRoles,
      pendingRoles: c.approvalChain.pendingRoles,
      satisfied: c.approvalChain.isSatisfied,
      rejected: c.approvalChain.isRejected,
      records: c.approvals.map((r) => ({
        role: r.role,
        approverId: r.approverId,
        decision: r.decision,
        decidedAt: r.decidedAt.toISOString(),
        ...(r.comment === undefined ? {} : { comment: r.comment }),
      })),
    },
    history: c.history.map((h) => ({
      fromState: h.fromState,
      toState: h.toState,
      event: h.event,
      actorId: h.actorId,
      occurredAt: h.occurredAt.toISOString(),
    })),
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function sendDomainError(reply: FastifyReply, error: DomainError): FastifyReply {
  return reply
    .code(error.httpStatusHint)
    .send({ error: { code: error.code, message: error.message } });
}

/**
 * Registers `/organizations/:orgId/compliance-cases/*`, mounted under `/admin`. Every route
 * authenticates the caller, checks a permission scoped to the organization in the path, then
 * delegates to a use case.
 *
 * The caller is identified by the `x-user-id` header until the principal plugin is used, so these
 * routes must only be reachable behind the session layer.
 */
export function registerComplianceCaseRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  deps: ComplianceCaseRouteDependencies,
): void {
  for (const schema of COMPLIANCE_CASE_SCHEMAS) {
    if (app.getSchema(schema.$id) === undefined) {
      app.addSchema(schema);
    }
  }

  const base = "/organizations/:orgId/compliance-cases";

  /** Returns the caller's id when authenticated and permitted, else replies 403. */
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    organizationId: string,
    permission: string,
  ): Promise<string | undefined> {
    const header = request.headers["x-user-id"];
    const userId = Array.isArray(header) ? header[0] : header;
    if (
      userId === undefined ||
      userId === "" ||
      !(await deps.permissions.hasPermission(userId, organizationId, permission))
    ) {
      await reply.code(403).send(FORBIDDEN_BODY);
      return undefined;
    }
    return userId;
  }

  app.post<{
    Params: { orgId: string };
    Body: { workflowType: WorkflowType; title: string; assigneeId?: string | null };
  }>(
    base,
    {
      schema: {
        params: { $ref: `${orgParamsSchema.$id}#` },
        body: { $ref: `${createCaseBodySchema.$id}#` },
      },
    },
    async (request, reply) => {
      const actorId = await authorize(
        request,
        reply,
        request.params.orgId,
        COMPLIANCE_CASE_PERMISSIONS.write,
      );
      if (actorId === undefined) return reply;

      const result = await deps.openCase.execute({
        organizationId: request.params.orgId,
        workflowType: request.body.workflowType,
        title: request.body.title,
        actorId,
        ...(request.body.assigneeId === undefined ? {} : { assigneeId: request.body.assigneeId }),
      });
      return Result.isErr(result)
        ? sendDomainError(reply, result.error)
        : reply.code(201).send(toResponse(result.value));
    },
  );

  app.get<{
    Params: { orgId: string };
    Querystring: { state?: string; type?: WorkflowType; assignee?: string };
  }>(
    base,
    {
      schema: {
        params: { $ref: `${orgParamsSchema.$id}#` },
        querystring: { $ref: `${listCasesQuerySchema.$id}#` },
      },
    },
    async (request, reply) => {
      const actorId = await authorize(
        request,
        reply,
        request.params.orgId,
        COMPLIANCE_CASE_PERMISSIONS.read,
      );
      if (actorId === undefined) return reply;

      const { state, type, assignee } = request.query;
      const cases = await deps.listCases.execute({
        organizationId: request.params.orgId,
        filter: {
          ...(state === undefined ? {} : { state }),
          ...(type === undefined ? {} : { workflowType: type }),
          ...(assignee === undefined ? {} : { assigneeId: assignee }),
        },
      });
      return reply.send({ items: cases.map(toResponse) });
    },
  );

  app.get<{ Params: { orgId: string; caseId: string } }>(
    `${base}/:caseId`,
    { schema: { params: { $ref: `${caseParamsSchema.$id}#` } } },
    async (request, reply) => {
      const actorId = await authorize(
        request,
        reply,
        request.params.orgId,
        COMPLIANCE_CASE_PERMISSIONS.read,
      );
      if (actorId === undefined) return reply;

      const result = await deps.getCase.execute({
        organizationId: request.params.orgId,
        caseId: request.params.caseId,
      });
      return Result.isErr(result)
        ? sendDomainError(reply, result.error)
        : reply.send(toResponse(result.value));
    },
  );

  app.post<{
    Params: { orgId: string; caseId: string };
    Body: { event: string; assigneeId?: string | null };
  }>(
    `${base}/:caseId/transitions`,
    {
      schema: {
        params: { $ref: `${caseParamsSchema.$id}#` },
        body: { $ref: `${transitionBodySchema.$id}#` },
      },
    },
    async (request, reply) => {
      const actorId = await authorize(
        request,
        reply,
        request.params.orgId,
        COMPLIANCE_CASE_PERMISSIONS.write,
      );
      if (actorId === undefined) return reply;

      const result = await deps.transitionCase.execute({
        organizationId: request.params.orgId,
        caseId: request.params.caseId,
        event: request.body.event,
        actorId,
        ...(request.body.assigneeId === undefined ? {} : { assigneeId: request.body.assigneeId }),
      });
      return Result.isErr(result)
        ? sendDomainError(reply, result.error)
        : reply.send(toResponse(result.value));
    },
  );

  app.post<{
    Params: { orgId: string; caseId: string };
    Body: { role: string; decision: "approved" | "rejected"; comment?: string };
  }>(
    `${base}/:caseId/approvals`,
    {
      schema: {
        params: { $ref: `${caseParamsSchema.$id}#` },
        body: { $ref: `${approvalBodySchema.$id}#` },
      },
    },
    async (request, reply) => {
      const approverId = await authorize(
        request,
        reply,
        request.params.orgId,
        COMPLIANCE_CASE_PERMISSIONS.approve,
      );
      if (approverId === undefined) return reply;

      const result = await deps.recordApproval.execute({
        organizationId: request.params.orgId,
        caseId: request.params.caseId,
        role: request.body.role,
        approverId,
        decision: request.body.decision,
        ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
      });
      if (Result.isErr(result)) {
        // Do not echo the failing role back as a permission oracle: an
        // ineligible approver gets the same generic 403 as any other denial.
        return result.error.httpStatusHint === 403
          ? reply.code(403).send(FORBIDDEN_BODY)
          : sendDomainError(reply, result.error);
      }
      return reply.send(toResponse(result.value));
    },
  );
}
