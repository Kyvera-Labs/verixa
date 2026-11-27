import type { Result, ValidationError } from "@verixa/shared-kernel";

/** The claims an access token carries. Deliberately minimal — see `JwtTokenSigner`. */
export interface AccessTokenPayload {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Signs and verifies access tokens. `verify` is for the route guard that authenticates requests.
 */
export interface TokenSigner {
  /** Signs `payload`, expiring `ttlSeconds` after signing. */
  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string>;
  /**
   * Verifies `token`'s signature and expiry, returning its payload.
   * Returns a `ValidationError` (never throws) for a malformed, expired, or
   * badly-signed token — an invalid token presented by a client is an
   * expected outcome, not a bug.
   */
  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>>;
}
