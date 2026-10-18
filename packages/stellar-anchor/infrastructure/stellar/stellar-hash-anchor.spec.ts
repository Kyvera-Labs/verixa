import { Keypair } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { StellarHashAnchor } from "./stellar-hash-anchor.js";

/**
 * The input guards of the Stellar adapter (Issue 210).
 *
 * `anchor()` and `verify()` both take strings that arrive from outside the
 * process — a CLI argument, a value read back from an `AnchorReceipt` row — and
 * `verify` puts one of them into an outbound URL. The rest of this class can
 * only be exercised against a real network (see the excluded
 * `*.testnet.spec.ts`), but *refusing* to make a request needs no network at
 * all, and that is the behaviour worth pinning down.
 *
 * The horizon URL is `.invalid`, a reserved TLD that can never resolve, and the
 * SDK refuses plain-HTTP endpoints outright. So if a guard ever stops firing,
 * the call falls through to a connection error and the assertion on the message
 * fails — which is the only way to test "this never left the process".
 */

const UNREACHABLE_HORIZON = "https://horizon.invalid";
const VALID_HASH = "a".repeat(64);
const VALID_TX_HASH = "f".repeat(64);

function anchor(): StellarHashAnchor {
  return new StellarHashAnchor({
    secretKey: Keypair.random().secret(),
    network: "testnet",
    horizonUrl: UNREACHABLE_HORIZON,
  });
}

describe("StellarHashAnchor.anchor", () => {
  it("refuses anything that is not a SHA-256 digest before submitting anything", async () => {
    const result = await anchor().anchor("not-a-digest");

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toMatch(/SHA-256 digest/);
    }
  });
});

describe("StellarHashAnchor.verify", () => {
  it("refuses a malformed hash without making a request", async () => {
    const result = await anchor().verify("not-a-digest", VALID_TX_HASH);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toMatch(/SHA-256 digest/);
    }
  });

  it("refuses a malformed transaction reference without making a request", async () => {
    // The payload shapes an injection review exists for: this value becomes a
    // path segment in a URL the adapter builds, and it is repeated into the
    // error message a CLI prints. Both are stopped by the same guard.
    for (const hostile of [
      "../../admin",
      `${VALID_TX_HASH}\nVERIFIED: everything is fine`,
      `${VALID_TX_HASH}?addr=GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890`,
      "",
      VALID_TX_HASH.slice(0, 63),
      "A".repeat(64),
    ]) {
      const result = await anchor().verify(VALID_HASH, hostile);

      expect(Result.isErr(result), `expected rejection for ${JSON.stringify(hostile)}`).toBe(true);
      if (Result.isErr(result)) {
        // Pinned to the exact text, which is the point: the message is a
        // constant, so it cannot be carrying the rejected value into whatever
        // log or console line prints it. A network error would not read like
        // this either — it would mean the guard had let the call through.
        expect(result.error.message).toBe(
          "Expected a 64-character lowercase hex transaction hash for anchorRef.",
        );
      }
    }
  });
});
