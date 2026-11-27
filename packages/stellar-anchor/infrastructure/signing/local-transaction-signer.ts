import { Keypair } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";

import {
  SigningError,
  type TransactionSigner,
} from "../../application/ports/transaction-signer.js";

/**
 * Signs with a key held in this process: the development path. It lets tests, local demos and
 * testnet run without a KMS. `describe()` identifies it as local so logs show which kind of key
 * signed; mainnet deployments use `KmsTransactionSigner` (see
 * docs/security/stellar-key-management.md).
 */
export class LocalTransactionSigner implements TransactionSigner {
  private readonly keypair: Keypair;

  /**
   * @param secretKey - the account's `S...` seed. Retained only as a `Keypair`;
   * never stored as a string, echoed in an error, or serialized.
   */
  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  accountId(): Promise<Result<string, SigningError>> {
    return Promise.resolve(Result.ok(this.keypair.publicKey()));
  }

  sign(digest: Uint8Array): Promise<Result<Uint8Array, SigningError>> {
    try {
      return Promise.resolve(Result.ok(this.keypair.sign(toBuffer(digest))));
    } catch (error) {
      // The message describes the operation, never the input: a signing
      // failure's diagnostics are precisely the string most likely to end up in
      // a log, and the input here is a value derived from transaction bytes that
      // may themselves be echoed by the SDK. No `cause` for the same reason —
      // see guarantee 4 of the port, which this implementation is the easiest
      // place to violate since the key is already in memory.
      return Promise.resolve(
        Result.err(
          new SigningError(
            `the local key could not sign these bytes (${error instanceof Error ? error.name : "unspecified error"})`,
          ),
        ),
      );
    }
  }

  describe(): string {
    return `local:${this.keypair.publicKey()}`;
  }

  /**
   * There is no private half to serialize, and `JSON.stringify(signer)` must not
   * invent one. Left to the default object shape this would expose whatever
   * `Keypair` keeps on itself — for `stellar-sdk`, the raw seed.
   */
  toJSON(): Record<string, string> {
    return { kind: "local", accountId: this.keypair.publicKey() };
  }

  toString(): string {
    return this.describe();
  }
}

/**
 * The SDK's Ed25519 layer takes a `Buffer`; the port speaks `Uint8Array` so no
 * caller has to depend on Node's buffer type in order to sign something.
 */
function toBuffer(digest: Uint8Array): Buffer {
  return Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength);
}
