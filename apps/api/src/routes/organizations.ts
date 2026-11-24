import { asId, Result } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";

import type { Container } from "../composition-root.js";
import { sendApiError, sendDomainError, sendError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";

const createOrganizationBodySchema = z
  .object({ name: z.string(), slug: z.string(), ownerId: z.string() })
  .strict();
const updateOrganizationBodySchema = z
  .object({ name: z.string().optional(), slug: z.string().optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.slug !== undefined, {
    message: "At least one organization field is required.",
  });
const organizationParamsSchema = z.object({ id: z.string() }).strict();
const emptyQuerySchema = z.object({}).strict();

type CreateOrganizationBody = z.infer<typeof createOrganizationBodySchema>;
type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;
type OrganizationParams = z.infer<typeof organizationParamsSchema>;

function header(request: { headers: Record<string, string | string[] | undefined> }, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function organizationResponse(organization: {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    ownerId: organization.ownerId,
    status: organization.status,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

/** Administrative organization routes. Authorization is deliberately checked
 * at the HTTP boundary before any use case or repository is invoked. */
export function registerOrganizationRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
import { sendError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";

const organizationParams = z.object({ organizationId: z.string().min(1) }).strict();
const organizationResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string(),
  parentOrganizationId: z.string().nullable(),
  status: z.enum(["active", "suspended", "deleted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export function registerOrganizationRoutes<TLogger extends FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  container: Container,
): void {
  const createBody = registerZodSchema(
    app,
    "AdminCreateOrganizationBody",
    createOrganizationBodySchema,
  );
  const updateBody = registerZodSchema(
    app,
    "AdminUpdateOrganizationBody",
    updateOrganizationBodySchema,
  );
  const params = registerZodSchema(app, "AdminOrganizationParams", organizationParamsSchema);
  const query = registerZodSchema(app, "AdminOrganizationQuery", emptyQuerySchema);

  const requirePermission = async (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { status: (status: number) => { send: (body: unknown) => unknown } },
    permission: string,
  ): Promise<boolean> => {
    const userId = header(request, "x-user-id");
    if (
      userId === undefined ||
      !(await container.authorization.hasPermission(userId, null, permission))
    ) {
      await reply.status(403).send({ error: { code: "FORBIDDEN", message: "Permission denied." } });
      return false;
    }
    return true;
  };

  app.get("/organizations", { schema: { querystring: query } }, async (request, reply) => {
    if (!(await requirePermission(request, reply, "organizations:read"))) return;
    try {
      const result = await container.identity.listOrganizations.execute();
      if (!Result.isOk(result)) return;
      return result.value.map(organizationResponse);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get<{ Params: OrganizationParams }>(
    "/organizations/:id",
    { schema: { params } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "organizations:read"))) return;
      try {
        const result = await container.identity.getOrganization.execute({
          id: asId(request.params.id),
        });
        if (Result.isErr(result) || result.value === undefined) {
          sendApiError(reply, "NOT_FOUND", "Organization not found.");
          return;
        }
        return organizationResponse(result.value);
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: CreateOrganizationBody }>(
    "/organizations",
    { schema: { body: createBody } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "organizations:write"))) return;
      try {
        const result = await container.identity.createOrganization.execute({
          name: request.body.name,
          slug: request.body.slug,
          ownerId: asId(request.body.ownerId),
        });
        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }
        return reply.status(201).send(organizationResponse(result.value.organization));
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.patch<{ Params: OrganizationParams; Body: UpdateOrganizationBody }>(
    "/organizations/:id",
    { schema: { params, body: updateBody } },
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "organizations:write"))) return;
      try {
        if (request.body.name === undefined && request.body.slug === undefined) {
          sendApiError(reply, "VALIDATION_ERROR", "At least one organization field is required.");
          return;
        }
        const result = await container.identity.updateOrganization.execute({
          id: asId(request.params.id),
          ...(request.body.name === undefined ? {} : { name: request.body.name }),
          ...(request.body.slug === undefined ? {} : { slug: request.body.slug }),
        });
        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }
        if (result.value === undefined) {
          sendApiError(reply, "NOT_FOUND", "Organization not found.");
          return;
        }
        return reply.status(200).send(organizationResponse(result.value));
      } catch (error) {
        sendError(reply, error);
      }
  const params = registerZodSchema(fastify, "OrganizationChildrenParams", organizationParams);
  const organization = registerZodSchema(fastify, "OrganizationResponse", organizationResponse);

  fastify.get(
    "/:organizationId/children",
    {
      schema: {
        description: "List the direct child organizations of an organization.",
        tags: ["Identity"],
        params,
        response: {
          200: { type: "array", items: organization },
        },
      },
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationParams>;
      const result = await container.identity.listChildOrganizations.execute(
        asId<"OrganizationId">(organizationId),
      );
      if (Result.isErr(result)) {
        sendError(reply, result.error);
        return;
      }
      return reply.send(
        result.value.map((organization) => ({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          ownerId: organization.ownerId,
          parentOrganizationId: organization.parentOrganizationId,
          status: organization.status,
          createdAt: organization.createdAt.toISOString(),
          updatedAt: organization.updatedAt.toISOString(),
        })),
      );
    },
  );
}
