#!/usr/bin/env node
import { Result } from "@verixa/shared-kernel";

import { isValidSha256Hex } from "../../application/ports/hash-anchor.js";
import { LocalTransactionSigner } from "../signing/local-transaction-signer.js";
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
 *
 * ## Anchoring through this CLI is a development path
 *
 * The CLI signs with a key read from the environment, which is the arrangement
 * `TransactionSigner` was introduced to replace. It stays because a testnet
 * experiment should not require a KMS, and because the alternative — no CLI at
 * all — would push operators to write their own, worse version. So it refuses to
 * sign on the public network unless explicitly overridden. Production anchoring
 * goes through the API's composition root, where a `KmsTransactionSigner` is
 * wired. See `docs/security/stellar-key-management.md`.
 */

const USAGE = `
Usage:
  anchor  <sha256-hex>                 Anchor a hash to Stellar (requires STELLAR_ANCHOR_SECRET_KEY)
  verify  <sha256-hex> <anchor-ref>    Check that a Stellar transaction commits to a hash

Environment:
  STELLAR_ANCHOR_SECRET_KEY   Secret key (S...) of the anchoring account. Required for "anchor".
                              Development and testnet only; see the note in this file's header.
  STELLAR_NETWORK             "testnet" (default) or "public".
  STELLAR_ALLOW_LOCAL_SIGNING Set to "1" to permit signing with the above on the public network.
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
