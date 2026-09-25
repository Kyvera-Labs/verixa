// Curated public surface of @verixa/mfa. Nothing outside this package
// should import from a deep path (`@verixa/mfa/domain/...`,
// `@verixa/mfa/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.

// Domain: entities & value objects
export type { MfaMethodId, MfaMethodStatus, MfaMethodProps } from "./domain/entities/mfa-method.js";
export { MfaMethod } from "./domain/entities/mfa-method.js";

export type {
  WebAuthnCredentialId,
  WebAuthnCredentialProps,
} from "./domain/entities/webauthn-credential.js";
export { WebAuthnCredential } from "./domain/entities/webauthn-credential.js";

export type {
  WebAuthnChallengeId,
  WebAuthnCeremonyType,
  WebAuthnChallengeProps,
} from "./domain/entities/webauthn-challenge.js";
export { WebAuthnChallenge } from "./domain/entities/webauthn-challenge.js";

export type { MfaMethodType } from "./domain/value-objects/mfa-method-type.js";

// Domain: events
export type { WebAuthnCloneSuspectedProps } from "./domain/events/webauthn-clone-suspected.js";
export { WebAuthnCloneSuspected } from "./domain/events/webauthn-clone-suspected.js";

// Application: ports
export type { MfaMethodRepository } from "./application/ports/mfa-method-repository.js";
export type { WebAuthnCredentialRepository } from "./application/ports/webauthn-credential-repository.js";
export type { WebAuthnChallengeRepository } from "./application/ports/webauthn-challenge-repository.js";
export type {
  AttestationVerifier,
  VerifiedAttestation,
  VerifyAttestationOptions,
} from "./application/ports/attestation-verifier.js";
export type {
  AssertionVerifier,
  VerifiedAssertion,
  VerifyAssertionOptions,
} from "./application/ports/assertion-verifier.js";

// Application: use cases
export type {
  RegisterWebAuthnCredentialConfig,
  IssueRegistrationChallengeCommand,
  IssueRegistrationChallengeResult,
  RegisterWebAuthnCredentialCommand,
  RegisterWebAuthnCredentialResult,
  RegisterWebAuthnCredentialError,
} from "./application/use-cases/register-webauthn-credential.js";
export { RegisterWebAuthnCredential } from "./application/use-cases/register-webauthn-credential.js";

export type {
  VerifyWebAuthnAssertionConfig,
  IssueAuthenticationChallengeCommand,
  IssueAuthenticationChallengeResult,
  VerifyWebAuthnAssertionCommand,
  VerifyWebAuthnAssertionResult,
  VerifyWebAuthnAssertionError,
} from "./application/use-cases/verify-webauthn-assertion.js";
export { VerifyWebAuthnAssertion } from "./application/use-cases/verify-webauthn-assertion.js";

// Infrastructure: adapters & fakes
export { WebAuthnAttestationVerifier } from "./infrastructure/webauthn/attestation-verifier.js";
export { WebAuthnAssertionVerifier } from "./infrastructure/webauthn/assertion-verifier.js";
export { InMemoryMfaMethodRepository } from "./infrastructure/fakes/in-memory-mfa-method-repository.js";
export { InMemoryWebAuthnCredentialRepository } from "./infrastructure/fakes/in-memory-webauthn-credential-repository.js";
export { InMemoryWebAuthnChallengeRepository } from "./infrastructure/fakes/in-memory-webauthn-challenge-repository.js";
export { InMemoryDomainEventPublisher } from "./infrastructure/fakes/in-memory-domain-event-publisher.js";
