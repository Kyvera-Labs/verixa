import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";

import { sendApiError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";

const submitVerificationZod = z
  .object({
    subjectUserId: z.string(),
    orgId: z.string(),
    verificationType: z.string(),
  })
  .strict();
const requestIdZod = z.object({ requestId: z.string() }).strict();
const decisionBodyZod = z
  .object({
    decision: z.enum(["approve", "reject", "request-more-info"]),
    reason: z.string().optional(),
  })
  .strict();

function routeSchemas<TLogger extends FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
) {
  return {
    submitVerification: {
      schema: {
        description: "Submit a new verification request",
        tags: ["Verification"],
        body: registerZodSchema(fastify, "SubmitVerificationBody", submitVerificationZod),
        response: {
          201: {
            type: "object",
            properties: {
              requestId: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    },
    submitEvidence: {
      schema: {
        description: "Submit evidence for a verification request",
        tags: ["Verification"],
        params: registerZodSchema(fastify, "VerificationRequestParams", requestIdZod),
        response: { 201: { type: "object", properties: { evidenceId: { type: "string" } } } },
      },
    },
    getStatus: {
      schema: {
        description: "Get verification request status",
        tags: ["Verification"],
        params: registerZodSchema(fastify, "VerificationStatusParams", requestIdZod),
        response: {
          200: {
            type: "object",
            properties: { requestId: { type: "string" }, status: { type: "string" } },
          },
        },
      },
    },
    reviewQueue: {
      schema: {
        description: "List review queue (reviewer only)",
        tags: ["Review Queue"],
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: { requestId: { type: "string" }, status: { type: "string" } },
            },
          },
        },
      },
    },
    claimCase: {
      schema: {
        description: "Claim next review case (reviewer only)",
        tags: ["Review Queue"],
        response: {
          200: {
            type: "object",
            properties: { requestId: { type: "string" }, status: { type: "string" } },
          },
        },
      },
    },
    decision: {
      schema: {
        description: "Review decision: approve, reject, or request-more-info (reviewer only)",
        tags: ["Review Queue"],
        params: registerZodSchema(fastify, "ReviewDecisionParams", requestIdZod),
        body: registerZodSchema(fastify, "ReviewDecisionBody", decisionBodyZod),
        response: {
          200: {
            type: "object",
            properties: { requestId: { type: "string" }, status: { type: "string" } },
          },
        },
      },
    },
  };
}

function checkReviewer(req: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.includes("reviewer")) {
    sendApiError(reply, "FORBIDDEN", "Reviewer role required");
    return false;
  }
  return true;
}

/**
 * Generic over the logger for the same reason `registerAuthRoutes` is: the
 * app is built with a concrete pino `Logger`, which is not structurally
 * identical to Fastify's `FastifyBaseLogger`, so pinning the default here
 * rejects the very instance `buildApp` produces.
 */
export function registerVerificationRoutes<TLogger extends FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  const schemas = routeSchemas(fastify);

  fastify.post(
    "/",
    { ...schemas.submitVerification, prefixTrailingSlash: "no-slash" },
    async (req, reply) => {
      const body = req.body as z.infer<typeof submitVerificationZod>;

      return reply.status(201).send({
        requestId: "req_mock_123",
        status: "pending_evidence",
        ...body,
      });
    },
  );

  fastify.post("/:requestId/evidence", schemas.submitEvidence, async (req, reply) => {
    const params = req.params as z.infer<typeof requestIdZod>;
    // `@fastify/multipart` augments the request with `file()`, but the
    // plugin is not registered yet, so the method may genuinely be absent.
    // Typed narrowly rather than cast to `any`: the shape actually relied on
    // is one optional method returning an optional stream.
    const multipart = req as FastifyRequest & {
      file?: () => { filename?: string; file?: NodeJS.ReadableStream } | undefined;
    };
    const data = multipart.file?.();

    const size = data?.file ? await getStreamSize(data.file) : 1024;

    if (size > 10 * 1024 * 1024) {
      sendApiError(reply as FastifyReply, "INVALID_EVIDENCE", "File size exceeds limit");
      return;
    }

    return reply.status(201).send({
      evidenceId: "ev_mock_123",
      requestId: params.requestId,
    });
  });

  fastify.get("/:requestId", schemas.getStatus, async (req, reply) => {
    const params = req.params as z.infer<typeof requestIdZod>;
    return reply.send({
      requestId: params.requestId,
      status: "pending_evidence",
    });
  });

  fastify.get("/review-queue", schemas.reviewQueue, async (req, reply) => {
    if (!checkReviewer(req, reply)) return;
    return reply.send([]);
  });

  fastify.post("/review-queue/claim", schemas.claimCase, async (req, reply) => {
    if (!checkReviewer(req, reply)) return;
    return reply.send({
      requestId: "req_claimed_123",
      status: "in_review",
    });
  });

  fastify.post(
    "/review-queue/:requestId/decision",
    schemas.decision,
    async (req, reply) => {
      if (!checkReviewer(req, reply)) return;
      const params = req.params as z.infer<typeof requestIdZod>;
      const body = req.body as z.infer<typeof decisionBodyZod>;

      const newStatus =
        body.decision === "approve"
          ? "approved"
          : body.decision === "reject"
            ? "rejected"
            : "needs_more_info";

      return reply.send({
        requestId: params.requestId,
        status: newStatus,
      });
    },
  );
}

async function getStreamSize(stream: NodeJS.ReadableStream): Promise<number> {
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
  }
  return size;
}
