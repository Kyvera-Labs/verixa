// Public API of @verixa/testing-kit. Deep imports are forbidden by `no-restricted-imports` in
// eslint.config.mjs (see docs/guides/domain-modeling.md). Names are listed explicitly so new
// helpers are never published by accident; document each one in
// docs/guides/tutorials/testing-the-platform.md or docs/guides/testing/.

// Builders: fluent, domain-valid test data with a history (Issue 419)
export { aCredential } from "./builders/credential.js";
export type { CredentialBuilder } from "./builders/credential.js";
export { aPendingInvitation } from "./builders/invitation.js";
export type { InvitationBuilder } from "./builders/invitation.js";
export { anMfaMethod } from "./builders/mfa-method.js";
export type { MfaMethodBuilder } from "./builders/mfa-method.js";
export { aVerificationRequest } from "./builders/verification-request.js";
export type { VerificationRequestBuilder } from "./builders/verification-request.js";

// Factories: Object Mothers for every core aggregate (Issue 402)
export { makeAuditEvent } from "./factories/audit-event.js";
export type { AuditEventFactoryOptions } from "./factories/audit-event.js";
export { makeCredential } from "./factories/credential.js";
export type { CredentialFactoryOptions } from "./factories/credential.js";
export { makeInvitation } from "./factories/invitation.js";
export type { InvitationFactoryOptions } from "./factories/invitation.js";
export { makeMfaMethod } from "./factories/mfa-method.js";
export type { MfaMethodFactoryOptions } from "./factories/mfa-method.js";
export { makeOrganizationMembership } from "./factories/organization-membership.js";
export type { OrganizationMembershipFactoryOptions } from "./factories/organization-membership.js";
export { makeOrganization } from "./factories/organization.js";
export type { OrganizationFactoryOptions } from "./factories/organization.js";
export { makeRefreshToken } from "./factories/refresh-token.js";
export type { RefreshTokenFactoryOptions } from "./factories/refresh-token.js";
export { makeSession } from "./factories/session.js";
export type { SessionFactoryOptions } from "./factories/session.js";
export { makeUser } from "./factories/user.js";
export type { UserFactoryOptions } from "./factories/user.js";
export { makeVerificationRequest } from "./factories/verification-request.js";
export type { VerificationRequestFactoryOptions } from "./factories/verification-request.js";

// Fakes: the in-memory adapter registry (Issue 403)
export type { ResettableFake } from "./fakes/fake-contract.js";
export { InMemoryRateLimiter } from "./fakes/rate-limiter.js";
export { InMemoryCaptchaValidator, NoopCaptchaValidator } from "./fakes/captcha.js";
export type { CaptchaValidator } from "./fakes/captcha.js";
export {
  // Identity
  InMemoryApiKeyRepository,
  InMemoryInvitationRepository,
  InMemoryOrganizationMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryUnitOfWork,
  InMemoryUserRepository,
  // Sessions
  InMemoryRevocationList,
  InMemorySessionAuditLogger,
  InMemorySessionRepository,
  // Credentials
  InMemoryCredentialRepository,
  InMemoryCredentialsUnitOfWork,
  InMemoryEmailVerificationTokenRepository,
  InMemoryPasswordResetTokenRepository,
  // MFA
  InMemoryDomainEventPublisher,
  InMemoryMfaMethodRepository,
  InMemoryWebAuthnChallengeRepository,
  InMemoryWebAuthnCredentialRepository,
  // Authorization
  InMemoryPermissionRepository,
  InMemoryPolicyRepository,
  InMemoryRoleRepository,
  InMemoryUserRoleAssignmentRepository,
  // Audit
  InMemoryAnchorRecordRepository,
  InMemoryAuditEventReader,
  InMemoryAuditLogRepository,
  // Verification
  InMemoryVerificationRequestRepository,
  // Shared kernel
  InMemoryBruteForceAttemptStore,
  InMemoryEventPublisher,
  // Stellar anchor
  InMemoryHashAnchor,
} from "./fakes/index.js";

// Contract tests: one suite, every adapter of a port (Issue 409)
export { defineContractTests } from "./contract-test.js";
export type { ContractImplementation, ContractSpec } from "./contract-test.js";

// Determinism: controllable time and randomness (Issue 404)
export { FixedClock } from "./fixed-clock.js";
export type { Clock } from "./fixed-clock.js";
export { SeededRandom } from "./seeded-random.js";
