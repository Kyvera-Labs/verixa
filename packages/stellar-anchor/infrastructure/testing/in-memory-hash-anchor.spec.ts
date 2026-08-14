import { createHash } from "node:crypto";

import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { InMemoryHashAnchor } from "./in-memory-hash-anchor.js";

const VALID_HASH = createHash("sha256").update("chain-tip").digest("hex");

describe("InMemoryHashAnchor", () => {
  it("simulates a ledger failure exactly once when armed", async () => {
    const anchor = new InMemoryHashAnchor();
    anchor.failNextAnchor();

    const failed = await anchor.anchor(VALID_HASH);
    const recovered = await anchor.anchor(VALID_HASH);

    expect(Result.isErr(failed) && failed.error.code).toBe("ANCHOR_FAILED");
    expect(Result.isOk(recovered)).toBe(true);
  });

  it("does not verify a reference that was never anchored", async () => {
    const anchor = new InMemoryHashAnchor();

    const verified = await anchor.verify(VALID_HASH, "never-anchored");

    expect(Result.isOk(verified) && verified.value).toBe(false);
  });

  it("gives each anchored hash its own reference", async () => {
    const anchor = new InMemoryHashAnchor();

    const first = await anchor.anchor(VALID_HASH);
    const second = await anchor.anchor(VALID_HASH);
    if (!Result.isOk(first) || !Result.isOk(second)) throw new Error("fixture setup failed");

    expect(first.value.anchorRef).not.toBe(second.value.anchorRef);
  });
});
