import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { SigningError } from "../../application/ports/transaction-signer.js";
import { KmsTransactionSigner } from "../signing/kms-transaction-signer.js";
import { LocalTransactionSigner } from "../signing/local-transaction-signer.js";
import { fakeKmsClient } from "../testing/fake-kms-sign-client.js";

import { StellarHashAnchor } from "./stellar-hash-anchor.js";

/**
 * Offline tests of the Stellar adapter's signing boundary: which operations need a signer, what
 * happens without one, and whether an externally produced signature is accepted by the SDK.
 * Anchoring itself is covered by `stellar-hash-anchor.testnet.spec.ts`. Seeds are generated at
 * runtime so no key-shaped fixture is committed.
 */
describe("StellarHashAnchor signing boundary", () => {
  describe("configured without a signer", () => {
    // The reason the constructor no longer demands a key: verification is meant
    // to be runnable by an auditor with no credentials at all, and the CLI used
    // to invent a throwaway keypair to satisfy a constructor that never needed
    // one. A credential-shaped fiction in a verify-only path is a documentation
    // bug waiting to become a production one.
    it("constructs", () => {
      expect(() => new StellarHashAnchor({ network: "testnet" })).not.toThrow();
    });

    it("refuses to anchor, and says why", async () => {
      const anchor = new StellarHashAnchor({ network: "testnet" });
      const result = await anchor.anchor("a".repeat(64));

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.message).toContain("without a signer");
        expect(result.error.message).toContain("verify");
      }
    });

    it("does not know an account id", async () => {
      const result = await new StellarHashAnchor({ network: "testnet" }).accountId();

      expect(Result.isErr(result)).toBe(true);
      if (Result.isErr(result)) {
        expect(result.error.message).toContain("No signer");
      }
    });
  });

  describe("configured with a signer", () => {
    it("reports the signer's account", async () => {
      const keypair = Keypair.random();
      const anchor = new StellarHashAnchor({
        signer: new LocalTransactionSigner(keypair.secret()),
        network: "testnet",
      });

      const result = await anchor.accountId();

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toBe(keypair.publicKey());
      }
    });

    it("turns a signer failure into an AnchorError", async () => {
      // A signer that cannot name its account cannot build a transaction either,
      // and the reason must reach the operator intact: "the key service is
      // unreachable" and "insufficient funds" call for very different fixes.
      const failure = new SigningError("the key service is unreachable");
      const signer: FailOnlySigner = {
        accountId: () => Promise.resolve(Result.err(failure)),
        sign: () => Promise.resolve(Result.err(failure)),
        describe: () => "failing:test",
      };

      const anchor = new StellarHashAnchor({ signer, network: "testnet" });

      const account = await anchor.accountId();
      expect(Result.isErr(account)).toBe(true);
      if (Result.isErr(account)) {
        expect(account.error.message).toContain("key service is unreachable");
      }

      const anchored = await anchor.anchor("b".repeat(64));
      expect(Result.isErr(anchored)).toBe(true);
      if (Result.isErr(anchored)) {
        expect(anchored.error.message).toContain("key service is unreachable");
      }
    });
  });

  /**
   * Signs a transaction's 32-byte digest outside the transaction object and attaches it with the
   * real SDK. `addSignature` verifies before attaching, so this also proves a remote signer's
   * output has the right format; a DER-wrapped signature fails here.
   */
  it("accepts a signature produced outside this process", async () => {
    const kms = fakeKmsClient();
    const signer = new KmsTransactionSigner({
      keyId: "alias/verixa-anchor",
      accountId: kms.keypair.publicKey(),
      client: kms.client,
    });

    const source = new Account(kms.keypair.publicKey(), "1");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: kms.keypair.publicKey(),
          asset: Asset.native(),
          amount: "0.0000001",
        }),
      )
      .addMemo(Memo.hash("c".repeat(64)))
      .setTimeout(60)
      .build();

    const signature = await signer.sign(transaction.hash());
    if (!Result.isOk(signature)) throw new Error("signing failed");
    expect(signature.value.byteLength).toBe(64);

    expect(() =>
      transaction.addSignature(
        kms.keypair.publicKey(),
        Buffer.from(signature.value).toString("base64"),
      ),
    ).not.toThrow();
    expect(transaction.signatures).toHaveLength(1);

    // The key never crossed the boundary: the client was asked to sign a digest
    // and nothing else.
    expect(kms.requests()).toHaveLength(1);
    expect(kms.requests()[0]?.digest.byteLength).toBe(32);
  });
});

/** A signer double that only fails, so no network and no key material are involved. */
interface FailOnlySigner {
  accountId(): Promise<Result<string, SigningError>>;
  sign(digest: Uint8Array): Promise<Result<Uint8Array, SigningError>>;
  describe(): string;
}
