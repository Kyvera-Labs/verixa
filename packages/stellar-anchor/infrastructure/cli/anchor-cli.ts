#!/usr/bin/env node
import { Keypair } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";

import { stroopsToXlm, type AnchorFundingAlert } from "../../application/ports/account-balance.js";
import { isValidSha256Hex } from "../../application/ports/hash-anchor.js";
import { AnchorBalanceMonitor, HorizonAccountBalanceReader } from "../balance-monitor.js";
import { LocalTransactionSigner } from "../signing/local-transaction-signer.js";
import { StellarHashAnchor, type StellarNetwork } from "../stellar/stellar-hash-anchor.js";

/**
 * Command-line anchoring and verification. Verification needs no secret key or funded account, so
 * an auditor, regulator or user can check a hash and transaction reference against the public
 * ledger independently.
 *
 * Anchoring through this CLI signs with a key from the environment and is meant for development and
 * testnet. It refuses the public network unless explicitly overridden; production anchoring uses
 * the API's `KmsTransactionSigner` (see docs/security/stellar-key-management.md).
 */

const USAGE = `
Usage:
  anchor  <sha256-hex>                 Anchor a hash to Stellar (requires STELLAR_ANCHOR_SECRET_KEY)
  verify  <sha256-hex> <anchor-ref>    Check that a Stellar transaction commits to a hash
  balance                              Report the anchoring account's balance as a metric line

Environment:
  STELLAR_ANCHOR_SECRET_KEY   Secret key (S...) of the anchoring account. Required for "anchor".
                              Development and testnet only; see the note in this file's header.
  STELLAR_NETWORK             "testnet" (default) or "public".
  STELLAR_ALLOW_LOCAL_SIGNING Set to "1" to permit signing with the above on the public network.
  STELLAR_ANCHOR_PUBLIC_KEY   Account to report in "balance", if the secret key is not available.
  STELLAR_NETWORK             "testnet" (default) or "public".
  STELLAR_ANCHOR_MIN_XLM      Alert threshold in XLM for "balance". Defaults to 1.

"balance" exits 0 when funded, 1 below the threshold, and 2 when the account
cannot cover a fee, the balance is unreadable, or Horizon is unreachable.
`.trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveNetwork(): StellarNetwork {
  const value = process.env["STELLAR_NETWORK"] ?? "testnet";
  if (value !== "testnet" && value !== "public") {
    fail(`STELLAR_NETWORK must be "testnet" or "public", received "${value}".`);
  }
  return value;
}

/**
 * Prints the anchoring account's balance as one structured metric line and exits non-zero when it
 * is running low, so it works as a dashboard input and a cron probe. Uses
 * `STELLAR_ANCHOR_PUBLIC_KEY` when set, so the watcher does not need the spending key; the secret
 * key is only a fallback.
 */
async function reportBalance(): Promise<never> {
  const network = resolveNetwork();
  const thresholdXlm = Number(process.env["STELLAR_ANCHOR_MIN_XLM"] ?? "1");
  if (!Number.isFinite(thresholdXlm) || thresholdXlm < 0) {
    fail("STELLAR_ANCHOR_MIN_XLM must be a non-negative number of XLM.");
  }

  const secretKey = process.env["STELLAR_ANCHOR_SECRET_KEY"];
  const publicKey =
    process.env["STELLAR_ANCHOR_PUBLIC_KEY"] ??
    (secretKey === undefined || secretKey.length === 0
      ? undefined
      : Keypair.fromSecret(secretKey).publicKey());

  if (publicKey === undefined) {
    fail(
      "balance needs STELLAR_ANCHOR_PUBLIC_KEY (preferred) or STELLAR_ANCHOR_SECRET_KEY to derive it from.",
    );
  }

  const alerts: AnchorFundingAlert[] = [];
  const monitor = new AnchorBalanceMonitor({
    reader: new HorizonAccountBalanceReader({ network }),
    publicKey,
    thresholdXlm,
    alerter: { alert: (alert) => void alerts.push(alert) },
  });

  const status = await monitor.check();

  console.log(
    JSON.stringify({
      name: "verixa_stellar_anchor_balance_xlm",
      network,
      publicKey,
      status: status.kind,
      availableXlm:
        status.kind === "unknown" ? undefined : stroopsToXlm(status.balance.availableStroops),
      thresholdXlm,
    }),
  );

  for (const alert of alerts) {
    console.error(`ALERT ${alert.kind}: ${alert.message}`);
  }

  // 0 funded, 1 below the alert threshold, 2 cannot pay a fee or cannot be
  // read at all — the difference lets a probe distinguish "top it up soon"
  // from "anchoring is not happening", which are different urgencies.
  process.exit(status.kind === "funded" ? 0 : status.kind === "below_threshold" ? 1 : 2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "balance") {
    await reportBalance();
  }

  if (command !== "anchor" && command !== "verify") {
    fail(USAGE);
  }

  const hash = args[0];
  if (hash === undefined || !isValidSha256Hex(hash)) {
    fail("Expected a 64-character lowercase hex SHA-256 digest as the first argument.");
  }

  const network = resolveNetwork();

  if (command === "verify") {
    const anchorRef = args[1];
    if (anchorRef === undefined) {
      fail(
        "verify requires an anchor reference (a Stellar transaction hash) as its second argument.",
      );
    }

    // No signer at all: verification only reads public ledger data. This used to
    // require a throwaway keypair purely to satisfy the constructor, which is the
    // kind of credential-shaped fiction that ends up in a runbook.
    const anchor = new StellarHashAnchor({ network });

    const result = await anchor.verify(hash, anchorRef);
    if (Result.isErr(result)) {
      fail(`Verification could not be completed: ${result.error.message}`);
    }

    if (result.value) {
      console.log(`VERIFIED: transaction ${anchorRef} commits to ${hash} on ${network}.`);
      process.exit(0);
    }

    console.error(`NOT VERIFIED: transaction ${anchorRef} does not commit to ${hash}.`);
    process.exit(1);
  }

  if (network === "public" && process.env["STELLAR_ALLOW_LOCAL_SIGNING"] !== "1") {
    fail(
      "Refusing to sign on the public network with a key from the environment.\nSet STELLAR_ALLOW_LOCAL_SIGNING=1 only if you accept the risk described in docs/security/stellar-key-management.md, and wire a KmsTransactionSigner instead.",
    );
  }

  const secretKey = process.env["STELLAR_ANCHOR_SECRET_KEY"];
  if (secretKey === undefined || secretKey.length === 0) {
    fail("STELLAR_ANCHOR_SECRET_KEY must be set to anchor a hash.");
  }

  const anchor = new StellarHashAnchor({ signer: new LocalTransactionSigner(secretKey), network });
  const result = await anchor.anchor(hash);

  if (Result.isErr(result)) {
    fail(`Anchoring failed: ${result.error.message}`);
  }

  console.log(`ANCHORED: ${hash}`);
  console.log(`  network:   ${result.value.network}`);
  console.log(`  reference: ${result.value.anchorRef}`);
  console.log(`  at:        ${result.value.anchoredAt.toISOString()}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
