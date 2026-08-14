#!/usr/bin/env node
import { Result } from "@verixa/shared-kernel";

import { isValidSha256Hex } from "../../application/ports/hash-anchor.js";
import { StellarHashAnchor, type StellarNetwork } from "../stellar/stellar-hash-anchor.js";

/**
 * Command-line access to anchoring and verification.
 *
 * The verification half matters more than it might look. An audit log's
 * integrity guarantee is worthless if only the operator's own software can
 * check it — the whole point of anchoring externally is that a third party
 * (an auditor, a regulator, a suspicious user) can confirm the commitment
 * without trusting, or even having access to, the operator's systems. This
 * CLI is that capability in its most portable form: give someone a hash and
 * a transaction reference, and they can check it themselves.
 *
 * Verifying needs no secret key and no funded account — it only reads public
 * ledger data.
 */

const USAGE = `
Usage:
  anchor  <sha256-hex>                 Anchor a hash to Stellar (requires STELLAR_ANCHOR_SECRET_KEY)
  verify  <sha256-hex> <anchor-ref>    Check that a Stellar transaction commits to a hash

Environment:
  STELLAR_ANCHOR_SECRET_KEY   Secret key (S...) of the anchoring account. Required for "anchor".
  STELLAR_NETWORK             "testnet" (default) or "public".
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

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

    // Verification only reads public ledger data, so the key here is
    // irrelevant — but the adapter needs *a* valid keypair to construct.
    // A throwaway one keeps verification usable with no credentials at all.
    const { Keypair } = await import("@stellar/stellar-sdk");
    const anchor = new StellarHashAnchor({ secretKey: Keypair.random().secret(), network });

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

  const secretKey = process.env["STELLAR_ANCHOR_SECRET_KEY"];
  if (secretKey === undefined || secretKey.length === 0) {
    fail("STELLAR_ANCHOR_SECRET_KEY must be set to anchor a hash.");
  }

  const anchor = new StellarHashAnchor({ secretKey, network });
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
