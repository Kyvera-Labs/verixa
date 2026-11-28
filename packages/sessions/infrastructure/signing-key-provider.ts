/**
 * Supplies the HMAC secret `JwtTokenSigner` uses. It is the seam for key rotation: during a
 * rotation `currentSecret` signs with the new key while `isKnownSecret` still accepts the old one
 * until its tokens expire. Today there is one key.
 */
export class SigningKeyProvider {
  private readonly secret: string;

  constructor(params: { secret: string }) {
    if (params.secret.trim() === "") {
      throw new Error("SigningKeyProvider requires a non-empty secret.");
    }
    this.secret = params.secret;
  }

  /** The secret new tokens are signed with. */
  currentSecret(): string {
    return this.secret;
  }

  /** Whether `secret` is one this provider accepts for verifying an already-issued token. */
  isKnownSecret(secret: string): boolean {
    return secret === this.secret;
  }
}
