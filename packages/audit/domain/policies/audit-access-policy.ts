import { DomainError, Result } from "@verixa/shared-kernel";

/**
 * Permissions that gate reading the audit log. Export is separate from query because it hands over
 * the whole filtered history at once. Strings use the RBAC `context:action` shape so they pass
 * straight through.
 */
export const AUDIT_PERMISSIONS = {
  query: "audit:query",
  export: "audit:export",
} as const;

/** The two ways the audit log can be read. */
export type AuditReadOperation = keyof typeof AUDIT_PERMISSIONS;

/**
 * Who is asking to read the audit log.
 *
 * Built by the interface layer from an authenticated session — never from the
 * request body. `permissions` is whatever the caller has been granted *within
 * `organizationId`*; until Phase 07/12 wires real RBAC, the composition root
 * is responsible for populating it, and an empty set (the safe default) grants
 * nothing.
 */
export interface AuditReader {
  readonly actorId: string;
  readonly organizationId: string;
  readonly permissions: ReadonlySet<string>;
}

/** Why a read was refused. Internal: logged and audited, never sent to the caller. */
export type AuditAccessDenialReason = "missing_permission" | "cross_organization";

/**
 * A read of the audit log was refused. The message is the same for every reason so a caller cannot
 * tell a foreign organization from a missing permission; `reason` is kept for the audit record and
 * omitted from {@link toJSON}.
 */
export class AuditAccessDeniedError extends DomainError {
  readonly code = "AUDIT_ACCESS_DENIED";
  readonly httpStatusHint = 403;
  readonly reason: AuditAccessDenialReason;

  constructor(reason: AuditAccessDenialReason) {
    super("You are not permitted to read this audit log.");
    this.reason = reason;
  }
}

/**
 * Decides whether `reader` may perform `operation` on `organizationId`'s audit log.
 *
 * Cross-organization requests are refused rather than silently rescoped, so the attempt becomes a
 * recorded event. There is no implicit operator override; one would have to be an explicit
 * permission checked here.
 */
export function authorizeAuditRead(
  reader: AuditReader,
  operation: AuditReadOperation,
  organizationId: string,
): Result<void, AuditAccessDeniedError> {
  if (reader.organizationId !== organizationId) {
    return Result.err(new AuditAccessDeniedError("cross_organization"));
  }

  const required = operation === "query" ? AUDIT_PERMISSIONS.query : AUDIT_PERMISSIONS.export;
  if (!reader.permissions.has(required)) {
    return Result.err(new AuditAccessDeniedError("missing_permission"));
  }

  return Result.ok(undefined);
}
