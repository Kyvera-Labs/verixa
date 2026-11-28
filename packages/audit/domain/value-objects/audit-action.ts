/**
 * Closed set of auditable actions, named `<context>.<entity>.<verb>` (for example
 * `identity.user.registered`). A closed set keeps spellings consistent so queries find every
 * matching event, and new security-relevant operations must be registered here explicitly.
 */
export type AuditAction =
  // Identity context
  | "identity.user.registered"
  | "identity.user.suspended"
  | "identity.user.reactivated"
  | "identity.user.profile_updated"
  | "identity.organization.created"
  | "identity.organization.invitation_sent"
  | "identity.api_key.created"
  // Credentials context
  | "credentials.user.registered_with_password"
  | "credentials.password.authentication_succeeded"
  | "credentials.password.authentication_failed"
  | "credentials.email.verification_requested"
  | "credentials.email.verification_completed"
  | "credentials.password.reset_requested"
  | "credentials.password.reset_completed"
  // Sessions context
  | "sessions.session.created"
  | "sessions.session.revoked"
  | "sessions.session.expired"
  // RBAC context
  | "rbac.role.assigned"
  | "rbac.role.revoked"
  | "rbac.permission.granted"
  | "rbac.permission.revoked"
  // Verification context
  | "verification.request.submitted"
  | "verification.evidence.submitted"
  | "verification.check.automated_completed"
  | "verification.review.claimed"
  | "verification.review.approved"
  | "verification.review.rejected"
  | "verification.review.more_info_requested"
  // Audit context (self-referential: auditing access to audit logs)
  | "audit.log.queried"
  | "audit.log.exported"
  | "audit.chain.verified"
  | "audit.chain.anchored";

/**
 * Type guard for valid audit actions.
 */
export function isAuditAction(value: string): value is AuditAction {
  const validActions: readonly string[] = [
    "identity.user.registered",
    "identity.user.suspended",
    "identity.user.reactivated",
    "identity.user.profile_updated",
    "identity.organization.created",
    "identity.organization.invitation_sent",
    "identity.api_key.created",
    "credentials.user.registered_with_password",
    "credentials.password.authentication_succeeded",
    "credentials.password.authentication_failed",
    "credentials.email.verification_requested",
    "credentials.email.verification_completed",
    "credentials.password.reset_requested",
    "credentials.password.reset_completed",
    "sessions.session.created",
    "sessions.session.revoked",
    "sessions.session.expired",
    "rbac.role.assigned",
    "rbac.role.revoked",
    "rbac.permission.granted",
    "rbac.permission.revoked",
    "verification.request.submitted",
    "verification.evidence.submitted",
    "verification.check.automated_completed",
    "verification.review.claimed",
    "verification.review.approved",
    "verification.review.rejected",
    "verification.review.more_info_requested",
    "audit.log.queried",
    "audit.log.exported",
    "audit.chain.verified",
    "audit.chain.anchored",
  ];

  return validActions.includes(value);
}
