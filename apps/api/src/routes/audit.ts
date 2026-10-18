import { AUDIT_EXPORT_HEADER, type AuditLogEntry, type AuditReader } from "@verixa/audit";
import { Result } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";

import type { Container } from "../composition-root.js";
import { sendApiError, sendDomainError, sendError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";
import { sanitizeLimit } from "../pagination/cursor-pagination.js";

/**
 * Query schema for GET /v1/audit
 */
const queryAuditEventsQueryZod = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    actorId: z.string().optional(),
    subjectId: z.string().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

type QueryAuditEventsQuery = z.infer<typeof queryAuditEventsQueryZod>;

/**
 * Query schema for GET /v1/audit/export
 */
const exportAuditEventsQueryZod = z
  .object({
    format: z.enum(["csv", "jsonl"]).default("jsonl"),
    actorId: z.string().optional(),
    subjectId: z.string().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

type ExportAuditEventsQuery = z.infer<typeof exportAuditEventsQueryZod>;

/**
 * Resolves the authenticated audit reader from request context / headers.
 */
function resolveAuditReader(req: FastifyRequest): AuditReader {
  const actorId =
    (req.headers["x-actor-id"] as string | undefined) ??
    (req.headers["x-user-id"] as string | undefined) ??
    "anonymous";

  const organizationId =
    (req.headers["x-organization-id"] as string | undefined) ??
    (req.headers["x-org-id"] as string | undefined) ??
    "";

  const rawPermissions = req.headers["x-permissions"];
  const permissions = new Set<string>();

  if (typeof rawPermissions === "string") {
    for (const p of rawPermissions.split(",")) {
      const trimmed = p.trim();
      if (trimmed.length > 0) permissions.add(trimmed);
    }
  } else if (Array.isArray(rawPermissions)) {
    for (const p of rawPermissions) {
      if (typeof p === "string" && p.trim().length > 0) permissions.add(p.trim());
    }
  }

  return {
    actorId,
    organizationId,
    permissions,
  };
}

/**
 * Converts an entry into public JSON presentation.
 */
function toEntryResponse(entry: AuditLogEntry) {
  return {
    id: entry.id,
    sequence: entry.sequence,
    action: entry.action,
    actorId: entry.actorId ?? null,
    subjectId: entry.subjectId ?? null,
    metadata: entry.metadata,
    occurredAt: entry.occurredAt.toISOString(),
    previousHash: entry.previousHash,
    hash: entry.hash,
  };
}

function escapeCsvCell(value: string): string {
  const neutralized = value.replace(/^[+=@-]/u, "'$&");
  return /[",\r\n]/u.test(neutralized) ? `"${neutralized.replace(/"/gu, '""')}"` : neutralized;
}

function entryToCsvRow(entry: AuditLogEntry): string {
  const fields = entry.toLogFields();
  return [
    fields["sequence"] ?? "",
    fields["action"] ?? "",
    fields["actorId"] ?? "",
    fields["subjectId"] ?? "",
    fields["occurredAt"] ?? "",
    fields["previousHash"] ?? "",
    fields["hash"] ?? "",
    fields["metadata"] ?? "",
  ]
    .map((field) => escapeCsvCell(field))
    .join(",");
}

function entryToJsonlRow(entry: AuditLogEntry): string {
  return JSON.stringify({
    sequence: entry.sequence,
    action: entry.action,
    actorId: entry.actorId ?? null,
    subjectId: entry.subjectId ?? null,
    occurredAt: entry.occurredAt.toISOString(),
    previousHash: entry.previousHash,
    hash: entry.hash,
    metadata: { ...entry.metadata },
  });
}

function encodeAuditCursor(sequence: number): string {
  const jsonStr = JSON.stringify({ sequence });
  return Buffer.from(jsonStr, "utf8").toString("base64url");
}

function decodeAuditCursor(cursor: string): number | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && "sequence" in parsed) {
      const seq = Number((parsed as Record<string, unknown>).sequence);
      return Number.isFinite(seq) ? seq : undefined;
    }
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  } catch {
    return undefined;
  }
}

export function registerAuditRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  container: Container,
): void {
  const querySchema = registerZodSchema(app, "QueryAuditEventsQuery", queryAuditEventsQueryZod);
  const exportSchema = registerZodSchema(app, "ExportAuditEventsQuery", exportAuditEventsQueryZod);

  // GET /v1/audit - Query audit events with cursor pagination
  app.get<{ Querystring: QueryAuditEventsQuery }>(
    "/",
    { schema: { querystring: querySchema } },
    async (request, reply) => {
      try {
        const reader = resolveAuditReader(request);
        if (!reader.organizationId) {
          sendApiError(
            reply,
            "AUDIT_ACCESS_DENIED",
            "Organization context required to query audit logs.",
          );
          return;
        }

        const queryUseCase = container.audit.queryEvents;
        if (!queryUseCase) {
          sendApiError(reply, "NOT_IMPLEMENTED", "Audit event querying is not enabled.");
          return;
        }

        const limit = sanitizeLimit(request.query.limit);
        const afterSequence = request.query.cursor
          ? decodeAuditCursor(request.query.cursor)
          : undefined;

        const result = await queryUseCase.execute({
          reader,
          organizationId: reader.organizationId,
          actorId: request.query.actorId,
          subjectId: request.query.subjectId,
          from: request.query.from ? new Date(request.query.from) : undefined,
          to: request.query.to ? new Date(request.query.to) : undefined,
          afterSequence,
          limit,
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        const { entries, nextCursor, hasMore } = result.value;
        const encodedNextCursor =
          nextCursor !== undefined && hasMore ? encodeAuditCursor(nextCursor) : null;

        await reply.status(200).send({
          items: entries.map(toEntryResponse),
          nextCursor: encodedNextCursor,
          hasMore,
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  // GET /v1/audit/export - Stream audit events as CSV or JSONL
  app.get<{ Querystring: ExportAuditEventsQuery }>(
    "/export",
    { schema: { querystring: exportSchema } },
    async (request, reply) => {
      try {
        const reader = resolveAuditReader(request);
        if (!reader.organizationId) {
          sendApiError(
            reply,
            "AUDIT_ACCESS_DENIED",
            "Organization context required to export audit logs.",
          );
          return;
        }

        const exportUseCase = container.audit.exportEvents;
        if (!exportUseCase) {
          sendApiError(reply, "NOT_IMPLEMENTED", "Audit event export is not enabled.");
          return;
        }

        const result = await exportUseCase.execute({
          reader,
          organizationId: reader.organizationId,
          actorId: request.query.actorId,
          subjectId: request.query.subjectId,
          from: request.query.from ? new Date(request.query.from) : undefined,
          to: request.query.to ? new Date(request.query.to) : undefined,
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        const stream = result.value;
        const format = request.query.format;

        if (format === "csv") {
          reply.header("Content-Type", "text/csv; charset=utf-8");
          reply.header("Content-Disposition", 'attachment; filename="audit-export.csv"');

          // Fastify reply as stream
          reply.raw.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="audit-export.csv"',
          });

          reply.raw.write(`${AUDIT_EXPORT_HEADER}\r\n`);
          for await (const entry of stream) {
            reply.raw.write(`${entryToCsvRow(entry)}\r\n`);
          }
          reply.raw.end();
          return;
        }

        // Default: jsonl
        reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="audit-export.jsonl"');

        reply.raw.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": 'attachment; filename="audit-export.jsonl"',
        });

        for await (const entry of stream) {
          reply.raw.write(`${entryToJsonlRow(entry)}\n`);
        }
        reply.raw.end();
      } catch (error) {
        sendError(reply, error);
      }
    },
  );
}
