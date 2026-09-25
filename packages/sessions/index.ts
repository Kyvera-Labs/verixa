// The public API of @verixa/sessions. Consumers import from the package root
// (`@verixa/sessions`), never a deep path — a context's domain/application
// internals are not part of its public surface. See
// docs/guides/domain-modeling.md ("Package encapsulation").
//
// This package is being built incrementally across Phase 05. What is exported
// here today is the slice landed so far: session identity, the access-token
// signer with key rotation (Issue 085), and the Redis revocation deny-list
// (Issue 088). The session aggregate, refresh tokens, and the issue/refresh/
// logout use cases arrive with their own issues.

// Domain: value objects
export { asSessionId, createSessionId } from "./domain/value-objects/session-id.js";
export type { SessionId } from "./domain/value-objects/session-id.js";

// Domain: errors
export { TokenVerificationError } from "./domain/errors/token-verification-error.js";
export type { TokenVerificationFailure } from "./domain/errors/token-verification-error.js";

// Application: ports (implemented by the infrastructure adapters below, and
// depended on by the use cases that will follow)
export type { RevocationList } from "./application/ports/revocation-list.js";
export type {
  AccessTokenInput,
  TokenSigner,
  VerifiedAccessToken,
} from "./application/ports/token-signer.js";

// Infrastructure: token signing & key rotation (Issue 084/085)
export { JwtTokenSigner } from "./infrastructure/jwt-token-signer.js";
export type { JwtTokenSignerOptions } from "./infrastructure/jwt-token-signer.js";
export { createConfigSigningKeyProvider } from "./infrastructure/signing-key-provider.js";
export type {
  ActiveSigningKey,
  SigningKeyProvider,
  VerificationKey,
} from "./infrastructure/signing-key-provider.js";

// Infrastructure: revocation deny-list (Issue 088)
export { RedisRevocationList } from "./infrastructure/redis-revocation-list.js";
export type { RedisRevocationListOptions } from "./infrastructure/redis-revocation-list.js";

// Testing: in-memory fake for consumers unit-testing against the revocation port
export { InMemoryRevocationList } from "./infrastructure/testing/in-memory-revocation-list.js";
