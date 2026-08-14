import { createHash } from "node:crypto";

import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { HashAnchor } from "../../../application/ports/hash-anchor.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Behavioral contract every `HashAnchor` implementation must satisfy. Run
 * against `InMemoryHashAnchor` on every test run, and against the real
 * `StellarHashAnchor` in the network-dependent integration suite — the same
 * one-suite-many-implementations approach the repository ports use (see
 * `docs/guides/testing.md`).
 *
 * That matters more here than usual. The in-memory fake is what almost every
 * other test will run against, so "the fake behaves like the real ledger" is
 * load-bearing: if `verify` returned `true` for a non-matching hash in one
 * implementation and `false` in the other, every test built on the fake
 * would be quietly meaningless.
 */
export function hashAnchorContract(createAnchor: () => HashAnchor): void {
  describe("HashAnchor contract", () => {
    it("anchors a valid SHA-256 digest and returns a receipt", async () => {
      const anchor = createAnchor();
      const hash = sha256Hex("audit-chain-tip-1");

      const result = await anchor.anchor(hash);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.hash).toBe(hash);
        expect(result.value.anchorRef).toBeTruthy();
        expect(result.value.anchoredAt).toBeInstanceOf(Date);
        expect(result.value.network).toBeTruthy();
      }
    });

    it("verifies a hash it just anchored", async () => {
      const anchor = createAnchor();
      const hash = sha256Hex("audit-chain-tip-2");

      const anchored = await anchor.anchor(hash);
      if (!Result.isOk(anchored)) throw new Error("fixture setup failed");

      const verified = await anchor.verify(hash, anchored.value.anchorRef);

      expect(Result.isOk(verified) && verified.value).toBe(true);
    });

    it("does not verify a different hash against the same reference", async () => {
      const anchor = createAnchor();
      const anchoredHash = sha256Hex("audit-chain-tip-3");
      const tamperedHash = sha256Hex("audit-chain-tip-3-tampered");

      const anchored = await anchor.anchor(anchoredHash);
      if (!Result.isOk(anchored)) throw new Error("fixture setup failed");

      const verified = await anchor.verify(tamperedHash, anchored.value.anchorRef);

      // This is the assertion the whole design exists for: a rewritten audit
      // chain produces a different tip hash, which no longer matches what was
      // committed to the ledger.
      expect(Result.isOk(verified) && verified.value).toBe(false);
    });

    it("rejects a hash that is not a 64-character hex SHA-256 digest", async () => {
      const anchor = createAnchor();

      const tooShort = await anchor.anchor("abc123");
      const notHex = await anchor.anchor("z".repeat(64));

      expect(Result.isErr(tooShort)).toBe(true);
      expect(Result.isErr(notHex)).toBe(true);
    });
  });
}
