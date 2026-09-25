import { DomainError, type Result } from "@verixa/shared-kernel";
import type { SessionId, UserId } from "../../domain/entities/session.js";

export type OrganizationId = string & { readonly __brand: "OrganizationId" };

/**
 * The claim set embedded in a JWT access token.
 *
 * These claims are the complete payload: a downstream service can decode
 * and verify the token (without a database round trip) using only the public
 * signing key, then extract these claims to make routing and authorization
 * decisions. The claims are deliberately minimal:
 *
 * - **`sub` (subject):** The user ID. Every request is from someone; the
 *   service needs to know who.
 * - **`sid` (session ID):** Links the token to its session. Allows revocation
 *   of an entire session without waiting for token expiry — a logout or
 *   theft-detected event revokes the session, and downstream verifiers check
 *   the revocation list (Issue 088).
 * - **`orgId` (organization ID):** Multi-tenancy hint. Allows a service to
 *   scope queries (e.g., "fetch this user's data for their org") without
 *   decoding the full token or doing a user lookup.
 * - **`iat` (issued at):** Unix timestamp when the token was signed. Used to
 *   detect clock skew and validate token freshness.
 * - **`exp` (expiration):** Unix timestamp when the token expires. Verifiers
 *   reject tokens where `exp ≤ now`.
 * - **`kid` (key ID):** Identifies which signing key was used. Enables
 *   zero-downtime key rotation (Issue 085): when a new key pair is created,
 *   the old public key is kept for verifying tokens issued moments before
 *   rotation. Verifiers use `kid` to look up the correct key.
 *
 * ## Why So Minimal?
 *
 * Access tokens are short-lived (typically 15 minutes). If we embedded roles,
 * permissions, or other fine-grained authorization data, that data would go
 * stale the moment a permission changed — the user would still have the old
 * permission until the token expired or was explicitly refreshed. Instead,
 * we keep tokens small and defer fine-grained authorization to a separate
 * query: a policy engine (Phase 08) fetches fresh permissions from the
 * database on each request. This separates concerns: tokens prove identity
 * and session validity, not authorization.
 *
 * The claims included here are enough for most services to avoid a user
 * lookup (orgId avoids a cross-tenant query, the session ID allows
 * revocation checking), but not so much that the token becomes a stale cache
 * of the user's current state.
 */
export interface AccessTokenClaims {
  /** Subject (user ID) */
  readonly sub: UserId;
  /** Session ID */
  readonly sid: SessionId;
  /** Organization ID (tenant) */
  readonly orgId: OrganizationId;
  /** Issued at (Unix timestamp) */
  readonly iat: number;
  /** Expiration (Unix timestamp) */
  readonly exp: number;
  /** Key ID (for rotation support, Issue 085) */
  readonly kid: string;
}

/**
 * A successfully signed access token.
 *
 * The token is stateless and self-contained: a JWT carrying the claims,
 * signed with the private key so the signature cannot be forged. Any service
 * holding the public key can verify the token and extract the claims without
 * contacting the issuer or a database. Revocation is handled out-of-band
 * via a deny-list (Issue 088).
 */
export interface SignedAccessToken {
  /** The raw JWT string (header.payload.signature) */
  readonly token: string;
  /** Decoded claims (for convenience; also embedded in the token) */
  readonly claims: AccessTokenClaims;
  /** When this token expires */
  readonly expiresAt: Date;
}

/**
 * Parameters for issuing a new access token.
 *
 * Used by the `IssueSession` use case (Issue 087) to request a token minted
 * with the specified claims and TTL. The signer is responsible for encoding
 * these into the JWT.
 */
export interface IssueAccessTokenParams {
  /** The user the token is for */
  readonly userId: UserId;
  /** The session this token belongs to */
  readonly sessionId: SessionId;
  /** The organization (tenant) the user belongs to */
  readonly organizationId: OrganizationId;
  /** When the token should expire */
  readonly expiresAt: Date;
}

/**
 * Signing failed (misconfiguration, missing key, etc).
 *
 * Returned in a Result rather than thrown because a signing failure is a
 * configuration or infrastructure issue the application layer should log and
 * treat seriously, not crash the whole request.
 */
export class SigningError extends DomainError {
  readonly code = "SIGNING_FAILED";
  readonly httpStatusHint = 500;
}

/**
 * Token verification failed because the signature is invalid.
 *
 * This means the token was forged or tampered with: the payload no longer
 * matches the signature. The token must be rejected immediately.
 */
export class InvalidSignatureError extends DomainError {
  readonly code = "INVALID_SIGNATURE";
  readonly httpStatusHint = 401;
}

/**
 * Token verification failed because the token has expired.
 *
 * The `exp` claim is in the past. The token must be rejected, and the client
 * should refresh (exchange the refresh token for a new access token).
 */
export class ExpiredTokenError extends DomainError {
  readonly code = "EXPIRED_TOKEN";
  readonly httpStatusHint = 401;
}

/**
 * Token verification failed because the token is malformed or incomplete.
 *
 * Examples: missing required claims, invalid base64 encoding, invalid JSON in
 * the payload. This is not a temporary error — no retry will fix it — so it is
 * logged as evidence of either a client bug or attempted tampering, and the
 * request is rejected.
 */
export class MalformedTokenError extends DomainError {
  readonly code = "MALFORMED_TOKEN";
  readonly httpStatusHint = 401;
}

/**
 * Ports for signing and verifying JWT access tokens.
 *
 * The port is deliberately implementation-agnostic: it does not mention RS256,
 * HS256, or any specific crypto library. An adapter could use node's native
 * crypto, OpenSSL, a third-party JWT library, or even a cloud HSM. The key
 * contract is:
 *
 * 1. Tokens signed by `sign()` can be verified by `verify()` (round-trip works).
 * 2. Any tampering or forgery causes `verify()` to throw a specific error
 *    (InvalidSignatureError, not a generic exception).
 * 3. Expiry is enforced: `verify()` rejects tokens where `exp ≤ now`.
 * 4. Verification is stateless: no database lookup, no session store, no
 *    infrastructure dependency. Only the public key and the token itself.
 *
 * **Why Asymmetric Signing (RS256)?**
 *
 * Verixa uses RS256 (RSA asymmetric signing) rather than HS256 (HMAC
 * symmetric). The difference:
 *
 * - **HS256 (symmetric):** One secret signs and verifies. The secret must be
 *   shared with every service that needs to verify tokens. If a verifier's copy
 *   is compromised, an attacker can forge tokens. Rotating the secret is
 *   operationally expensive: every verifier must be updated in lockstep, or
 *   verification fails.
 *
 * - **RS256 (asymmetric):** A private key signs, a public key verifies. The
 *   public key can be published freely — it can only verify, never sign. This
 *   scales naturally: the auth service holds the private key, and any other
 *   service that needs to verify tokens just needs the public key (which can be
 *   fetched from a well-known endpoint, JWKS, etc.). Key rotation is simple:
 *   create a new key pair, publish the new public key, and keep publishing the
 *   old one for a grace period so tokens issued moments before rotation can
 *   still be verified.
 *
 * For a single-service monolith, the distinction is moot. For a system that
 * might grow to multiple services (API gateway, microservices, webhooks, etc.),
 * RS256 is the natural choice. Verixa assumes the latter: it's easier to start
 * with asymmetric signing and never need the complexity than to start with
 * symmetric and face a breaking change later.
 *
 * See `docs/security/token-design.md` for the full rationale and threat model.
 */
export interface TokenSigner {
  /**
   * Sign and return a new access token with the given claims.
   *
   * **Contract:**
   * - The returned token can be verified by `verify()` using the corresponding
   *   public key.
   * - The token encodes all claims passed in `params`, plus `iat` (issued-at
   *   time, set to now).
   * - Consecutive calls with the same params produce different tokens (each
   *   gets a unique timestamp/nonce) but both verify to the same claims.
   * - The returned `expiresAt` matches the `expiresAt` passed in params.
   *
   * **Parameters:**
   * - `params.expiresAt` is expected to be in the future. Signing with an
   *   expiration in the past is rejected — it would be a no-op token.
   *
   * @throws SigningError if the operation fails (missing or corrupted key,
   *   infrastructure failure).
   *
   * @returns A signed access token. The `claims` are provided for convenience
   *   (so callers don't have to decode the JWT); the `token` is the canonical
   *   form to send to clients.
   */
  sign(params: IssueAccessTokenParams): Promise<Result<SignedAccessToken, SigningError>>;

  /**
   * Verify and decode a JWT access token.
   *
   * **Contract:**
   * - Verifies the signature matches the payload, using the key identified by
   *   the `kid` header.
   * - Verifies the token has not expired: `exp > now`.
   * - Verifies all required claims are present and have the expected shape.
   * - Returns the decoded claims if all checks pass.
   *
   * **Error Handling:**
   * - Signature mismatch (forged or tampered token) throws InvalidSignatureError.
   * - Expired token (exp ≤ now) throws ExpiredTokenError.
   * - Malformed token (missing claims, invalid JSON, invalid base64) throws
   *   MalformedTokenError.
   * - Other failures (unknown key ID, infrastructure issue) throw MalformedTokenError
   *   as a safe default — a verifier should reject the request, not crash.
   *
   * Throwing specific error types (rather than returning a Result) is deliberate:
   * verification is expected to succeed nearly always. A throw is rare and
   * signals something genuinely wrong (tampering, misconfiguration, or an
   * internal bug) that should be logged at high severity.
   *
   * @param token The raw JWT string (header.payload.signature).
   * @returns The decoded claims.
   * @throws InvalidSignatureError, ExpiredTokenError, or MalformedTokenError.
   */
  verify(token: string): Promise<AccessTokenClaims>;
}
