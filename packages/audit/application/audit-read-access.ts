import { DomainError, Result } from "@verixa/shared-kernel";

import {
  type AuditAccessDeniedError,
  type AuditReader,
  type AuditReadOperation,
  authorizeAuditRead,
} from "../domain/policies/audit-access-policy.js";

import type { AuditEventCriteria } from "./ports/audit-event-reader.js";
import type { RecordAuditEvent } from "./use-cases/record-audit-event.js";

/**
 * A read was authorized but could not be recorded, so it was not performed.
 *
 * 503 rather than 500: nothing about the request was wrong, and retrying once
 * the audit store is reachable again is the correct client behaviour.
 */
export class AuditReadNotRecordedError extends DomainError {
  readonly code = "AUDIT_READ_NOT_RECORDED";
  readonly httpStatusHint = 503;

  constructor() {
    super("The audit log is temporarily unavailable. Try again shortly.");
  }
}

export type AuditReadError = AuditAccessDeniedError | AuditReadNotRecordedError;

/**
 * The criteria as audit metadata. Only the fields actually supplied, and dates
 * as ISO strings — metadata is `Record<string, string>` so it canonicalizes
 * into the entry hash the same way on every platform.
 */
function describe(criteria: AuditEventCriteria): Record<string, string> {
  const metadata: Record<string, string> = { organizationId: criteria.organizationId };
  if (criteria.actorId !== undefined) metadata["filter.actorId"] = criteria.actorId;
  if (criteria.subjectId !== undefined) metadata["filter.subjectId"] = criteria.subjectId;
  if (criteria.from !== undefined) metadata["filter.from"] = criteria.from.toISOString();
  if (criteria.to !== undefined) metadata["filter.to"] = criteria.to.toISOString();
  return metadata;
}

/**
 * Authorizes a read of the audit log and records it before any entry is returned. Shared by query
 * and export so neither path can skip a step.
 *
 * Denied reads are recorded as `audit.access_denied` on a best-effort basis. If an allowed read
 * cannot be recorded, the read fails closed: nothing has been disclosed yet, and serving it anyway
 * would let someone read the log unobserved by first breaking audit writes.
 */
export async function authorizeAndRecordAuditRead(
  recordAuditEvent: RecordAuditEvent,
  reader: AuditReader,
  operation: AuditReadOperation,
  criteria: AuditEventCriteria,
): Promise<Result<void, AuditReadError>> {
  const decision = authorizeAuditRead(reader, operation, criteria.organizationId);

  if (Result.isErr(decision)) {
    await recordAuditEvent.execute({
      action: "audit.access_denied",
      actorId: reader.actorId,
      subjectId: criteria.organizationId,
      metadata: {
        ...describe(criteria),
        operation,
        reason: decision.error.reason,
        actorOrganizationId: reader.organizationId,
      },
    });
    return decision;
  }

  const recorded = await recordAuditEvent.execute({
    action: operation === "query" ? "audit.queried" : "audit.exported",
    actorId: reader.actorId,
    subjectId: criteria.organizationId,
    metadata: describe(criteria),
  });

  if (recorded === undefined) {
    return Result.err(new AuditReadNotRecordedError());
  }

  return Result.ok(undefined);
}
