import { z } from "zod";

import type { AuditAction } from "./audit-action.js";

/**
 * Metadata schema registry: one Zod schema per audit action, so metadata is structured, consistent
 * and queryable.
 *
 * Keep metadata minimal and never include secrets or unnecessary PII; actor, resource, timestamp
 * and organization are already fields on the event. Reuse field names (`oldValue`/`newValue`,
 * `reason`, `ipAddress`). Fields are optional unless the event is meaningless without them. Add a
 * schema here for every new action.
 */

// Base schemas for common metadata patterns
const baseMetadataSchema = z.object({}).strict();

const ipAddressSchema = z
  .object({
    // Zod 4 split .ip() into ipv4()/ipv6(); the union accepts the same values.
    ipAddress: z.union([z.ipv4(), z.ipv6()]).optional(),
    userAgent: z.string().optional(),
  })
  .strict();

const changeMetadataSchema = z
  .object({
    changes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const reasonMetadataSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

// Identity context schemas
const identityUserRegisteredSchema = baseMetadataSchema;

const identityUserSuspendedSchema = reasonMetadataSchema;

const identityUserReactivatedSchema = reasonMetadataSchema;

const identityUserProfileUpdatedSchema = changeMetadataSchema;

const identityOrganizationCreatedSchema = z
  .object({
    organizationName: z.string().optional(),
  })
  .strict();

const identityOrganizationInvitationSentSchema = z
  .object({
    inviteeEmail: z.string().email().optional(),
    roleId: z.string().optional(),
  })
  .strict();

// Credentials context schemas
const credentialsUserRegisteredWithPasswordSchema = baseMetadataSchema;

const credentialsPasswordAuthenticationSucceededSchema = ipAddressSchema;

const credentialsPasswordAuthenticationFailedSchema = ipAddressSchema.extend({
  failureReason: z.enum(["invalid_credentials", "account_locked", "other"]).optional(),
});

const credentialsEmailVerificationRequestedSchema = z
  .object({
    email: z.string().email().optional(),
  })
  .strict();

const credentialsEmailVerificationCompletedSchema = z
  .object({
    email: z.string().email().optional(),
  })
  .strict();

const credentialsPasswordResetRequestedSchema = z
  .object({
    email: z.string().email().optional(),
  })
  .strict()
  .merge(ipAddressSchema);

const credentialsPasswordResetCompletedSchema = ipAddressSchema;

// Sessions context schemas
const sessionsSessionCreatedSchema = ipAddressSchema;

const sessionsSessionRevokedSchema = reasonMetadataSchema;

const sessionsSessionExpiredSchema = baseMetadataSchema;

// RBAC context schemas
const rbacRoleAssignedSchema = z
  .object({
    roleId: z.string(),
    subjectId: z.string(),
  })
  .strict()
  .merge(reasonMetadataSchema);

const rbacRoleRevokedSchema = z
  .object({
    roleId: z.string(),
    subjectId: z.string(),
  })
  .strict()
  .merge(reasonMetadataSchema);

const rbacPermissionGrantedSchema = z
  .object({
    permission: z.string(),
    subjectId: z.string(),
  })
  .strict()
  .merge(reasonMetadataSchema);

const rbacPermissionRevokedSchema = z
  .object({
    permission: z.string(),
    subjectId: z.string(),
  })
  .strict()
  .merge(reasonMetadataSchema);

// Verification context schemas
const verificationRequestSubmittedSchema = z
  .object({
    verificationType: z.string().optional(),
  })
  .strict();

const verificationEvidenceSubmittedSchema = z
  .object({
    evidenceType: z.string().optional(),
    evidenceCount: z.number().optional(),
  })
  .strict();

const verificationCheckAutomatedCompletedSchema = z
  .object({
    providerName: z.string().optional(),
    outcome: z.enum(["passed", "failed", "inconclusive"]).optional(),
    confidenceScore: z.number().min(0).max(1).optional(),
  })
  .strict();

const verificationReviewClaimedSchema = z
  .object({
    reviewerId: z.string().optional(),
  })
  .strict();

const verificationReviewApprovedSchema = reasonMetadataSchema.extend({
  reviewerId: z.string().optional(),
});

const verificationReviewRejectedSchema = reasonMetadataSchema.extend({
  reviewerId: z.string().optional(),
});

const verificationReviewMoreInfoRequestedSchema = reasonMetadataSchema.extend({
  reviewerId: z.string().optional(),
});

// Audit context schemas
const auditLogQueriedSchema = z
  .object({
    filters: z.record(z.string(), z.unknown()).optional(),
    resultCount: z.number().optional(),
  })
  .strict();

const auditLogExportedSchema = z
  .object({
    format: z.enum(["csv", "json"]).optional(),
    recordCount: z.number().optional(),
  })
  .strict();

const auditChainVerifiedSchema = z
  .object({
    chainLength: z.number().optional(),
    isValid: z.boolean().optional(),
    firstBreak: z.number().optional(),
  })
  .strict();

const auditChainAnchoredSchema = z
  .object({
    anchorRef: z.string().optional(),
    recordCount: z.number().optional(),
  })
  .strict();

/**
 * The complete metadata schema registry.
 *
 * Maps each action to its validation schema. Actions not present in this map
 * accept any JSON object (permissive fallback), but every action **should**
 * have an explicit schema.
 */
export const AUDIT_METADATA_SCHEMAS: Partial<Record<AuditAction, z.ZodTypeAny>> = {
  // Identity
  "identity.user.registered": identityUserRegisteredSchema,
  "identity.user.suspended": identityUserSuspendedSchema,
  "identity.user.reactivated": identityUserReactivatedSchema,
  "identity.user.profile_updated": identityUserProfileUpdatedSchema,
  "identity.organization.created": identityOrganizationCreatedSchema,
  "identity.organization.invitation_sent": identityOrganizationInvitationSentSchema,
  // Credentials
  "credentials.user.registered_with_password": credentialsUserRegisteredWithPasswordSchema,
  "credentials.password.authentication_succeeded": credentialsPasswordAuthenticationSucceededSchema,
  "credentials.password.authentication_failed": credentialsPasswordAuthenticationFailedSchema,
  "credentials.email.verification_requested": credentialsEmailVerificationRequestedSchema,
  "credentials.email.verification_completed": credentialsEmailVerificationCompletedSchema,
  "credentials.password.reset_requested": credentialsPasswordResetRequestedSchema,
  "credentials.password.reset_completed": credentialsPasswordResetCompletedSchema,
  // Sessions
  "sessions.session.created": sessionsSessionCreatedSchema,
  "sessions.session.revoked": sessionsSessionRevokedSchema,
  "sessions.session.expired": sessionsSessionExpiredSchema,
  // RBAC
  "rbac.role.assigned": rbacRoleAssignedSchema,
  "rbac.role.revoked": rbacRoleRevokedSchema,
  "rbac.permission.granted": rbacPermissionGrantedSchema,
  "rbac.permission.revoked": rbacPermissionRevokedSchema,
  // Verification
  "verification.request.submitted": verificationRequestSubmittedSchema,
  "verification.evidence.submitted": verificationEvidenceSubmittedSchema,
  "verification.check.automated_completed": verificationCheckAutomatedCompletedSchema,
  "verification.review.claimed": verificationReviewClaimedSchema,
  "verification.review.approved": verificationReviewApprovedSchema,
  "verification.review.rejected": verificationReviewRejectedSchema,
  "verification.review.more_info_requested": verificationReviewMoreInfoRequestedSchema,
  // Audit
  "audit.log.queried": auditLogQueriedSchema,
  "audit.log.exported": auditLogExportedSchema,
  "audit.chain.verified": auditChainVerifiedSchema,
  "audit.chain.anchored": auditChainAnchoredSchema,
};

/**
 * Validates metadata against the schema for the given action.
 *
 * Returns the validated (and potentially transformed) metadata if valid, or
 * throws a ZodError if validation fails.
 *
 * Actions without a registered schema accept any object (permissive fallback).
 */
export function validateAuditMetadata(
  action: AuditAction,
  metadata: unknown,
): Record<string, unknown> {
  const schema = AUDIT_METADATA_SCHEMAS[action];

  if (schema === undefined) {
    // Permissive fallback: accept any object-shaped metadata for unregistered actions
    if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
      return metadata as Record<string, unknown>;
    }
    return {};
  }

  return schema.parse(metadata) as Record<string, unknown>;
}
