import type {
  AccessTokenClaims,
  IssueAccessTokenParams,
  SignedAccessToken,
} from "../../domain/value-objects/access-token.js";

/**
 * Port for JWT access token signing and verification.
 *
 * This interface decouples the access token issuance logic from the cryptographic
 * mechanism. Implementations (RS256, HS256, etc.) must satisfy the same contract:
 * - Tokens signed via `sign()` can be verified via `verify()`
 * - Tampered tokens are rejected
 * - Expired tokens are rejected
 * - Verification is stateless (no database lookup required)
 *
 * **Why JWT (not opaque tokens)?**
 * Access tokens must be short-lived and stateless-verifiable. A JWT carrying
 * claims can be verified by any service holding the public key without hitting
 * a database or cache, making it efficient for high-concurrency systems.
 * Revocation is handled separately via a deny-list (Issue 088).
 *
 * **Why RS256 (not HS256)?**
 * RS256 (RSA asymmetric signing) allows multiple services to verify tokens using
 * the public key, without needing access to the private signing key. HS256
 * (HMAC symmetric) would require sharing the secret with every service that
 * needs to verify, increasing the surface area for key compromise. Asymmetric
 * signing also aligns with JWKS endpoints (Issue 085) for key rotation.
 *
 * Contract testing ensures that any implementation produces the same observable
 * behavior as any other (sign/verify round-trip, tamper rejection, expiry checks).
 */
export interface TokenSigner {
  /**
   * Sign and return a new access token with the given claims.
   *
   * **Parameters:**
   * - `params.userId`: The user for whom the token is being issued.
   * - `params.sessionId`: The session this token belongs to. Allows the session
   *   to be revoked without waiting for the token to expire.
   * - `params.organizationId`: The organization (tenant) the user belongs to.
   * - `params.expiresAt`: When the token should expire. Typically 15 minutes from now.
   *
   * **Returns:**
   * A `SignedAccessToken` containing the raw JWT string and decoded claims
   * (for convenience; the claims are also embedded in the token).
   *
   * **Design notes:**
   * - `expiresAt` is passed in rather than calculated here, so that all issuances
   *   can use a consistent clock (the `IssueSession` use case's time, not the
   *   signer's internal `new Date()`). This is especially important in tests
   *   where time must be mocked uniformly.
   * - The returned claims include `kid` (key ID), which downstream verifiers use
   *   to look up the correct public key for verification. This enables zero-downtime
   *   key rotation (Issue 085).
   *
   * @throws Error if the signing key is not available (e.g., misconfiguration).
   */
  sign(params: IssueAccessTokenParams): Promise<SignedAccessToken>;

  /**
   * Verify and decode a JWT access token.
   *
   * **Parameters:**
   * - `token`: The raw JWT string (header.payload.signature).
   *
   * **Returns:**
   * The decoded claims if verification succeeds.
   *
   * **Verification checks:**
   * 1. **Signature validity:** The token's signature must match the payload,
   *    using the key identified by the `kid` header. An altered payload or
   *    forged signature is rejected.
   * 2. **Expiry:** The `exp` claim must be in the future. An expired token is
   *    rejected with an `ExpiredTokenError` (or similar).
   * 3. **Required fields:** All expected claims must be present (sub, sid, orgId,
   *    iat, exp, kid). Malformed tokens are rejected.
   *
   * **Revocation is NOT checked here.** Revocation is handled by a separate
   * deny-list service (Issue 088), called after verification succeeds. This
   * separation keeps token verification stateless and fast.
   *
   * @throws VerificationError (or subclass) if the token is invalid:
   *   - Signature mismatch (forged or tampered)
   *   - Expired (exp in the past)
   *   - Malformed (missing claims, invalid structure)
   *   - Unknown key ID (kid not found in available keys; see Issue 085)
   */
  verify(token: string): Promise<AccessTokenClaims>;
}

/**
 * Marker error for when a token signature is invalid (forged or tampered).
 *
 * Used by verifiers to distinguish signature failures from other validation
 * errors (expiry, malformed, etc.) so they can log or alert appropriately.
 */
export class InvalidSignatureError extends Error {
  readonly code = "INVALID_SIGNATURE";

  constructor(message: string = "Token signature is invalid") {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

/**
 * Marker error for when a token has expired.
 *
 * The `exp` claim is in the past relative to the verification time.
 */
export class ExpiredTokenError extends Error {
  readonly code = "EXPIRED_TOKEN";

  constructor(message: string = "Token has expired") {
    super(message);
    this.name = "ExpiredTokenError";
  }
}

/**
 * Marker error for when a token is malformed or structurally invalid.
 *
 * Examples: missing claims, invalid base64 encoding, invalid JSON in payload.
 */
export class MalformedTokenError extends Error {
  readonly code = "MALFORMED_TOKEN";

  constructor(message: string = "Token is malformed or invalid") {
    super(message);
    this.name = "MalformedTokenError";
  }
}

/**
 * Marker error for when a token references a signing key that is not available.
 *
 * This can happen during key rotation if a key has been completely retired
 * without a grace period, or if the `kid` header is corrupted.
 */
export class UnknownKeyError extends Error {
  readonly code = "UNKNOWN_KEY";

  constructor(message: string = "Token references an unknown signing key") {
    super(message);
    this.name = "UnknownKeyError";
  }
}
