import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

import type {
  AccessTokenClaims,
  IssueAccessTokenParams,
  SignedAccessToken,
} from "../domain/value-objects/access-token.js";
import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
  type TokenSigner,
} from "../application/ports/token-signer.js";

/**
 * JWT (RS256) implementation of the TokenSigner port.
 *
 * Uses asymmetric RSA signing (RS256) so that:
 * 1. The private key is held only by this service (the token issuer)
 * 2. Any service holding the public key can verify tokens independently
 *    without calling back to the issuer
 * 3. Key rotation is non-breaking (old keys are retired but continue to
 *    verify existing tokens until they expire)
 *
 * RS256 is the standard choice for JWT-based access tokens in production
 * systems where multiple services need to verify tokens (e.g., API gateway,
 * microservices, webhooks). Symmetric signing (HS256) would require sharing
 * the signing key with every verifier, which is a larger attack surface and
 * doesn't scale well.
 *
 * **Thread safety:**
 * This implementation is stateless and thread-safe. Multiple concurrent calls
 * to `sign()` and `verify()` are safe.
 */
export class JwtTokenSigner implements TokenSigner {
  private cachedPrivateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
  private cachedPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null;

  /**
   * Create a new JWT token signer.
   *
   * @param privateKeyPem - The private RSA key in PEM format (PKCS#8). Used for signing.
   * @param publicKeyPem - The public RSA key in PEM format (SPKI). Used for verifying.
   * @param keyId - A short identifier for this key (e.g., "2024-01-15-v1"). Embedded
   *   in the JWT header as the `kid` claim to support key rotation (Issue 085).
   */
  constructor(
    private readonly privateKeyPem: string,
    private readonly publicKeyPem: string,
    private readonly keyId: string,
  ) {}

  /**
   * Lazily import and cache the private key (async operation).
   * This avoids repeated PEM parsing on every sign() call.
   */
  private async getPrivateKey() {
    if (!this.cachedPrivateKey) {
      this.cachedPrivateKey = await importPKCS8(this.privateKeyPem, "RS256");
    }
    return this.cachedPrivateKey;
  }

  /**
   * Lazily import and cache the public key (async operation).
   * This avoids repeated PEM parsing on every verify() call.
   */
  private async getPublicKey() {
    if (!this.cachedPublicKey) {
      this.cachedPublicKey = await importSPKI(this.publicKeyPem, "RS256");
    }
    return this.cachedPublicKey;
  }

  async sign(params: IssueAccessTokenParams): Promise<SignedAccessToken> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.floor(params.expiresAt.getTime() / 1000);

    // Validate that expiration is in the future
    if (expiresAt <= issuedAt) {
      throw new Error("Token expiration must be in the future");
    }

    const claims: AccessTokenClaims = {
      sub: params.userId,
      sid: params.sessionId,
      orgId: params.organizationId,
      iat: issuedAt,
      exp: expiresAt,
      kid: this.keyId,
    };

    try {
      const privateKey = await this.getPrivateKey();

      // Create and sign the JWT
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.keyId })
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(privateKey);

      return {
        token,
        claims,
        expiresAt: params.expiresAt,
      };
    } catch (error) {
      throw new Error(
        `Failed to sign access token: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const publicKey = await this.getPublicKey();

      // Verify the JWT signature and extract claims
      // jose automatically checks expiration as part of verification
      const result = await jwtVerify(token, publicKey);
      const payload = result.payload;

      // Validate the presence of required claims
      if (
        !payload.sub ||
        !payload.sid ||
        !payload.orgId ||
        !payload.iat ||
        !payload.exp ||
        !payload.kid
      ) {
        throw new MalformedTokenError("Token is missing required claims");
      }

      return {
        sub: payload.sub as string,
        sid: payload.sid as string,
        orgId: payload.orgId as string,
        iat: payload.iat as number,
        exp: payload.exp as number,
        kid: payload.kid as string,
      };
    } catch (error) {
      // Map jose errors to our custom error types for consistency
      if (error instanceof MalformedTokenError || error instanceof ExpiredTokenError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      // Signature verification failures
      if (message.includes("signature") || message.includes("invalid")) {
        throw new InvalidSignatureError(`Signature verification failed: ${message}`);
      }

      // Expiry check
      if (message.includes("exp") || message.includes("expired")) {
        throw new ExpiredTokenError(`Token has expired: ${message}`);
      }

      // Default to malformed
      throw new MalformedTokenError(`Token verification failed: ${message}`);
    }
  }
}
