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
