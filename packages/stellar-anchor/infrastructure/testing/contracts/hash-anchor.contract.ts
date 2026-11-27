import { createHash } from "node:crypto";

import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { HashAnchor } from "../../../application/ports/hash-anchor.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Behavioural contract for every `HashAnchor`, run against `InMemoryHashAnchor` and, in the network
 * suite, `StellarHashAnchor` (see docs/guides/testing.md). Most tests use the in-memory fake, so it
 * must behave exactly like the real ledger, especially `verify` on a non-matching hash.
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
