import { Result } from "@verixa/shared-kernel";

import {
  SigningError,
  type TransactionSigner,
} from "../../application/ports/transaction-signer.js";

/**
 * The remote signing capability this adapter needs: one method taking a key identifier and the
 * bytes to sign, which maps to AWS `kms:Sign`, GCP `asymmetricSign` and Azure Key Vault `sign`. Key
 * management operations stay out of the request path.
 */
export interface KmsSignClient {
  /**
   * Signs `digest` under `keyId` and resolves with the resulting 64-byte raw
   * Ed25519 signature.
   *
   * Raw, not DER: AWS returns ECDSA signatures DER-encoded, so an AWS adapter
   * must unwrap them. Ed25519 in AWS KMS returns the 64 bytes directly. The
   * unwrap belongs in the adapter because it is a vendor detail, and the
   * application must not learn about vendor details.
   */
  sign(request: KmsSignRequest): Promise<Uint8Array>;
}

export interface KmsSignRequest {
  readonly keyId: string;
  readonly digest: Uint8Array;
}

export interface KmsTransactionSignerOptions {
  /**
   * Identifier of the asymmetric signing key — an ARN, a key-version resource
   * name, a Vault key name. Not secret: it appears in request paths and audit
   * logs by design.
   */
  readonly keyId: string;
  /**
   * The Stellar account (`G...`) this key signs for. Passed in rather than
   * derived from the KMS because the mapping between a KMS key and a Stellar
   * strkey is not the KMS's job, and a deployment that got it wrong should fail
   * at startup with a clear message rather than at submission with a confusing
   * one. See `docs/runbooks/stellar-mainnet-cutover.md` for the derivation step.
   */
  readonly accountId: string;
  readonly client: KmsSignClient;
}

/**
 * Signs through a KMS or HSM, so the private key never exists in this process. Nothing can leak
 * through crash dumps, logs, manifests or CI. A fully compromised process can still ask the KMS to
 * sign, but only within its IAM policy and with the KMS's audit trail. Scoping who may call the key
 * remains the operator's job.
 */
export class KmsTransactionSigner implements TransactionSigner {
  constructor(private readonly options: KmsTransactionSignerOptions) {}

  accountId(): Promise<Result<string, SigningError>> {
    // Resolved from configuration rather than a remote call, and asserted here so
    // a deployment that pasted a seed instead of an account gets a `Result` at
    // startup rather than an inscrutable submission failure later.
    if (!this.options.accountId.startsWith("G")) {
      return Promise.resolve(
        Result.err(
          new SigningError(
            `configured account is not a Stellar account key (expected a G... strkey, got a ${String(this.options.accountId.length)}-character value)`,
          ),
        ),
      );
    }
    return Promise.resolve(Result.ok(this.options.accountId));
  }

  async sign(digest: Uint8Array): Promise<Result<Uint8Array, SigningError>> {
    if (digest.byteLength === 0) {
      return Result.err(new SigningError("refused to sign an empty digest"));
    }

    let signature: Uint8Array;
    try {
      signature = await this.options.client.sign({
        keyId: this.options.keyId,
        digest,
      });
    } catch (error) {
      // A summary, and deliberately no `cause`. This is the one place a vendor
      // SDK's error object could reach a log, and such errors routinely carry
      // the request they failed — which contains the digest. Guarantee 4 of the
      // port exists precisely so that nothing helping to reconstruct a
      // signature travels with the failure, and `error.cause` would smuggle it
      // past a `message` check into any logger that walks the chain. The error
      // *name* is enough to diagnose "which failure", which is what an operator
      // needs at 3am; "what bytes did you send" is not a debugging requirement
      // for a signing call whose inputs the caller already knows.
      return Result.err(
        new SigningError(
          `the key service refused the signing request (${error instanceof Error ? error.name : "unspecified error"})`,
        ),
      );
    }

    // Checked before returning, so a mis-unwrapped DER signature surfaces here
    // with a clear reason instead of arriving at the network as an invalid
    // signature against a spent fee.
    if (signature.byteLength !== 64) {
      return Result.err(
        new SigningError(
          `key service returned a ${String(signature.byteLength)}-byte signature; Ed25519 signatures are 64 bytes, so the response was probably not unwrapped from its DER encoding`,
        ),
      );
    }

    return Result.ok(signature);
  }

  describe(): string {
    return `kms:${this.options.keyId}`;
  }

  /**
   * Safe to serialize: the key identifier is public by design and the client is
   * an object with no key material in it, but the point of this method is that a
   * future field cannot accidentally become loggable.
   */
  toJSON(): Record<string, string> {
    return { kind: "kms", keyId: this.options.keyId, accountId: this.options.accountId };
  }

  toString(): string {
    return this.describe();
  }
}
