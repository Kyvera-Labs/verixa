import { DomainError, type Result } from "@verixa/shared-kernel";

/**
 * Signing failed remotely or the key was unusable. Returned rather than thrown, so a briefly
 * unreachable KMS skips one anchoring run instead of crashing. Messages must never contain key
 * material.
 */
export class SigningError extends DomainError {
  readonly code = "SIGNING_FAILED";
  // 502: an upstream service the caller depends on refused to do its job.
  readonly httpStatusHint = 502;

  /**
   * @param detail - a human-readable reason that contains **no** key material,
   * identifiers for the key are fine, the key itself never is.
   */
  constructor(detail: string, options?: ErrorOptions) {
    super(`Transaction signing failed: ${detail}`, options);
  }
}

/**
 * Produces Ed25519 signatures for a Stellar account without exposing the private key to the caller.
 * A secret in the process environment can leak through sidecars, crash dumps, logs, CI output and
 * manifest backups; behind this port the key stays in an HSM, KMS or external signer.
 *
 * Every implementation must guarantee:
 *
 * 1. The private key never enters this process. A `Keypair`-based implementation is for development
 *    only and must say so in its name and `describe()`.
 * 2. `sign` signs exactly the bytes given, with no hashing or re-encoding.
 * 3. No secret appears in `describe()`, `toJSON()`, `toString()` or any `SigningError` message.
 * 4. Failures are `Result`s with a code and summary, never a raw upstream payload, including
 *    through `cause`.
 * 5. `accountId()` never changes for an instance.
 *
 * The port takes the 32-byte digest rather than a `Transaction`, so no Stellar SDK types reach the
 * application layer.
 */
export interface TransactionSigner {
  /**
   * The Stellar account (strkey, `G...`) whose key signs. Public and safe to
   * log; it is how an auditor finds the anchors on the ledger.
   */
  accountId(): Promise<Result<string, SigningError>>;

  /**
   * Signs `digest` — the raw bytes a Stellar transaction is signed over, i.e.
   * `transaction.hash()` — and returns a 64-byte raw Ed25519 signature.
   *
   * Returns raw bytes rather than a decorated signature or base64 string so
   * callers can attach it however their SDK version expects, and so a
   * signature-validity test can compare against the public key without parsing.
   */
  sign(digest: Uint8Array): Promise<Result<Uint8Array, SigningError>>;

  /**
   * One line describing where signing happens, for logs and startup banners:
   * `kms:alias/verixa-anchor`, or `local:` followed by the *public* account id.
   * Never contains key material — see guarantee 3 above.
   */
  describe(): string;
}
