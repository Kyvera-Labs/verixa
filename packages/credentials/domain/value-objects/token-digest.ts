import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Issuing and checking single-use bearer tokens for email verification and password reset. Shared
 * as functions rather than a base class, because the two tokens have different rules (see
 * docs/security/token-storage.md).
 */

/** Bytes of entropy in an issued token. */
const TOKEN_BYTES = 32;

/**
 * Generates a 256-bit raw bearer token from a CSPRNG, base64url-encoded so it is compact and
 * URL-safe.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 of a raw token, hex-encoded; the only form ever persisted. A fast hash is enough because
 * tokens are 256 random bits, so there is nothing to brute-force, and a leaked database still
 * yields no working tokens.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether `token` hashes to `digest`, compared in constant time so response timing cannot reveal
 * how much of a digest matched.
 */
export function tokenMatchesDigest(token: string, digest: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const actual = Buffer.from(digest, "hex");

  // `timingSafeEqual` throws on length mismatch rather than returning false,
  // which would turn a malformed stored digest into a 500 instead of a failed
  // check. Lengths are equal for any two SHA-256 digests, so this only fires
  // on corruption — and corruption should read as "no match".
  if (candidate.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(candidate, actual);
}
