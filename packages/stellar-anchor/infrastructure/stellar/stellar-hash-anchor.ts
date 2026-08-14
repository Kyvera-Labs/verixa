import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";

import {
  AnchorError,
  type AnchorReceipt,
  type HashAnchor,
  isValidSha256Hex,
} from "../../application/ports/hash-anchor.js";

export type StellarNetwork = "testnet" | "public";

const HORIZON_URLS: Readonly<Record<StellarNetwork, string>> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

const NETWORK_PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  testnet: Networks.TESTNET,
  public: Networks.PUBLIC,
};

/**
 * The smallest amount Stellar can represent (1 stroop). The anchoring
 * transaction pays this to the anchoring account itself: a transaction needs
 * at least one operation to carry a memo, and a self-payment of one stroop
 * is the least consequential operation available — it moves no value
 * anywhere and leaves no lasting state, unlike `manageData`, which would
 * permanently raise the account's minimum balance requirement.
 */
const SELF_PAYMENT_AMOUNT = "0.0000001";

const TRANSACTION_TIMEOUT_SECONDS = 60;

export interface StellarHashAnchorOptions {
  /** Secret key (`S...`) of the account that submits anchoring transactions. Never log this. */
  readonly secretKey: string;
  readonly network: StellarNetwork;
  /** Overrides the default Horizon endpoint for the chosen network. Mainly for tests. */
  readonly horizonUrl?: string;
}

/**
 * Anchors hashes to Stellar by submitting a minimal transaction whose
 * `MEMO_HASH` memo *is* the hash.
 *
 * Why a memo rather than a smart contract: the entire requirement is "record
 * 32 bytes on an append-only public ledger, cheaply, and be able to read
 * them back." Stellar's `MEMO_HASH` field is exactly 32 bytes — the exact
 * size of a SHA-256 digest, so the hash goes in whole, with no truncation
 * or encoding workaround. No Soroban contract, no token, no on-chain logic:
 * less to deploy, less to audit, and nothing that can be exploited beyond
 * the transaction itself.
 *
 * **Only ever anchor a hash.** A hash is a one-way commitment — it proves
 * the underlying record existed unchanged, while revealing nothing about
 * its contents. The audit log itself stays entirely in the operator's own
 * database. Putting audit *content* on a public ledger would be an
 * irreversible data leak, so this adapter accepts nothing but a validated
 * SHA-256 digest.
 */
export class StellarHashAnchor implements HashAnchor {
  private readonly keypair: Keypair;
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly networkId: string;

  constructor(options: StellarHashAnchorOptions) {
    this.keypair = Keypair.fromSecret(options.secretKey);
    this.server = new Horizon.Server(options.horizonUrl ?? HORIZON_URLS[options.network]);
    this.networkPassphrase = NETWORK_PASSPHRASES[options.network];
    this.networkId = `stellar:${options.network}`;
  }

  /** The public key anchoring transactions are submitted from. Safe to log and share — it's how anyone locates the anchor history. */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async anchor(hash: string): Promise<Result<AnchorReceipt, AnchorError>> {
    if (!isValidSha256Hex(hash)) {
      return Result.err(
        new AnchorError(
          `Expected a 64-character lowercase hex SHA-256 digest, received ${String(hash.length)} characters.`,
        ),
      );
    }

    try {
      const account = await this.server.loadAccount(this.keypair.publicKey());

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: this.keypair.publicKey(),
            asset: Asset.native(),
            amount: SELF_PAYMENT_AMOUNT,
          }),
        )
        .addMemo(Memo.hash(hash))
        .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
        .build();

      transaction.sign(this.keypair);

      const response = await this.server.submitTransaction(transaction);

      return Result.ok({
        hash,
        anchorRef: response.hash,
        anchoredAt: new Date(),
        network: this.networkId,
      });
    } catch (error) {
      return Result.err(
        new AnchorError(`Failed to anchor hash to Stellar: ${describeError(error)}`, {
          cause: error,
        }),
      );
    }
  }

  async verify(hash: string, anchorRef: string): Promise<Result<boolean, AnchorError>> {
    if (!isValidSha256Hex(hash)) {
      return Result.err(new AnchorError("Expected a 64-character lowercase hex SHA-256 digest."));
    }

    try {
      const transaction = await this.server.transactions().transaction(anchorRef).call();

      if (transaction.memo_type !== "hash" || transaction.memo === undefined) {
        return Result.ok(false);
      }

      // Horizon returns a MEMO_HASH memo base64-encoded; the anchored value
      // is the raw 32 bytes, so compare in hex rather than trying to match
      // encodings.
      const anchoredHash = Buffer.from(transaction.memo, "base64").toString("hex");

      return Result.ok(anchoredHash === hash);
    } catch (error) {
      return Result.err(
        new AnchorError(`Failed to verify anchor ${anchorRef}: ${describeError(error)}`, {
          cause: error,
        }),
      );
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
