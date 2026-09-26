import type { Result } from "@verixa/shared-kernel";

import type { TokenVerificationError } from "../../domain/errors/token-verification-error.js";
import type { SessionId } from "../../domain/value-objects/session-id.js";

/**
 * The claims a caller asks to embed in a freshly minted access token.
 *
 * This is the *input* shape, not the wire shape: it names things in domain
 * terms (`subject`, `sessionId`) and leaves the registered JWT claim names
 * (`sub`, `sid`, `iat`, `exp`) and the `kid` header to the adapter. Keeping the
 * mapping on the infrastructure side of this port is what lets the token format
 * change — different claim names, a switch away from JWT entirely — without any
 * use case that issues tokens having to change with it.
 */
export interface AccessTokenInput {
  /** The authenticated principal — a user id. Becomes the `sub` claim. */
  readonly subject: string;
  /** The session this token belongs to. Becomes the `sid` claim. */
  readonly sessionId: SessionId;
  /** Active tenant/organization, when the caller is scoped to one. `orgId`. */
  readonly organizationId?: string;
  /**
   * Coarse role hints, present so a downstream service can make a cheap
   * first-pass authorization decision without a database round trip. They are
   * a *hint*, never the source of truth — the authoritative check still runs
   * against the RBAC/ABAC engines in later phases. Kept minimal on purpose: an
   * access token is a bearer credential that travels widely and is only as
   * fresh as its `exp`, so stuffing a full permission set into it both bloats
   * every request and makes a revoked grant linger until the token expires.
   */
  readonly roles?: readonly string[];
}

/**
 * The verified, decoded contents of an access token the adapter has already
 * checked: correctly signed by a key it trusts, and not expired.
 */
export interface VerifiedAccessToken {
  readonly subject: string;
  readonly sessionId: SessionId;
  readonly organizationId?: string;
  readonly roles: readonly string[];
  /** The `kid` the token was actually verified under — useful for audit. */
  readonly keyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Mints and verifies stateless access tokens.
 *
 * "Stateless" is the whole point: {@link verify} answers "is this a genuine,
 * unexpired token this system issued?" from the token and the verifier's keys
 * alone, with no store lookup. That is what makes access-token verification
 * cheap enough to run on every request in every service. The price is that a
 * token stays valid until it expires even if the session behind it should die
 * sooner — which is exactly the gap the revocation deny-list (Issue 088) and
 * short token lifetimes close, not this port.
 *
 * Verification errors come back as a {@link Result}, not a thrown exception:
 * an invalid or expired token is an ordinary, expected outcome on an auth
 * boundary (every unauthenticated request produces one), not an exceptional
 * condition. See `docs/guides/use-cases.md` on Result-vs-throw.
 */
export interface TokenSigner {
  /** Signs `input` into a compact JWS string using the current signing key. */
  sign(input: AccessTokenInput): Promise<string>;

  /**
   * Verifies and decodes `token`. Returns the decoded claims on success, or a
   * {@link TokenVerificationError} explaining the rejection (unknown key,
   * bad signature, expiry, malformed input).
   */
  verify(token: string): Promise<Result<VerifiedAccessToken, TokenVerificationError>>;
}
