import { createHmac, timingSafeEqual } from "node:crypto";

import { Result, ValidationError } from "@verixa/shared-kernel";

import type { AccessTokenPayload, TokenSigner } from "../application/ports/token-signer.js";

import type { SigningKeyProvider } from "./signing-key-provider.js";

const HEADER = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

interface AccessTokenClaims extends AccessTokenPayload {
  readonly iat: number;
  readonly exp: number;
}

function isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    typeof claims["sessionId"] === "string" &&
    typeof claims["userId"] === "string" &&
    typeof claims["exp"] === "number"
  );
}

/**
 * Signs and verifies access tokens as HS256 JWTs using `node:crypto`, without a JWT library. The
 * format is standard; implementing a single algorithm avoids `alg: none` and algorithm confusion,
 * and adds no dependency on a security-critical path.
 *
 * Claims are only `sessionId` and `userId`. Authorization re-checks current state rather than
 * trusting role claims that could go stale (see docs/security/authentication-flows.md).
 */
export class JwtTokenSigner implements TokenSigner {
  constructor(private readonly keyProvider: SigningKeyProvider) {}

  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      sessionId: payload.sessionId,
      userId: payload.userId,
      iat: now,
      exp: now + ttlSeconds,
    };
    const body = base64UrlEncode(JSON.stringify(claims));
    const signature = this.computeSignature(`${HEADER}.${body}`, this.keyProvider.currentSecret());

    return Promise.resolve(`${HEADER}.${body}.${signature}`);
  }

  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token.")));
    }
    const [header, body, signature] = parts as [string, string, string];

    const expectedSignature = this.computeSignature(
      `${header}.${body}`,
      this.keyProvider.currentSecret(),
    );
    if (!timingSafeEqualStrings(signature, expectedSignature)) {
      return Promise.resolve(Result.err(new ValidationError("Access token signature is invalid.")));
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token payload.")));
    }

    if (!isAccessTokenClaims(decoded)) {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token payload.")));
    }

    if (Date.now() >= decoded.exp * 1000) {
      return Promise.resolve(Result.err(new ValidationError("Access token has expired.")));
    }

    return Promise.resolve(Result.ok({ sessionId: decoded.sessionId, userId: decoded.userId }));
  }

  private computeSignature(segment: string, secret: string): string {
    return createHmac("sha256", secret).update(segment, "utf8").digest("base64url");
  }
}

/** Timing-safe comparison of two possibly-different-length strings — see `Invitation.matchesToken`. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
