import { describe, expect, it } from "vitest";

import { Argon2PasswordHasher, DEFAULT_ARGON2_PARAMETERS } from "./argon2-password-hasher.js";

/**
 * Most tests use weak parameters so the suite stays fast; the properties tested do not depend on
 * cost. The one test of real cost uses the production defaults explicitly.
 */
const FAST = { memoryCost: 64, timeCost: 1, parallelism: 1 };

describe("Argon2PasswordHasher", () => {
  const hasher = new Argon2PasswordHasher(FAST);

  it("verifies a password against its own hash", async () => {
    const encoded = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("correct horse battery staple", encoded)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const encoded = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("Correct horse battery staple", encoded)).resolves.toBe(false);
    await expect(hasher.verify("", encoded)).resolves.toBe(false);
  });

  it("produces a different hash every time, even for identical passwords", async () => {
    const first = await hasher.hash("same password");
    const second = await hasher.hash("same password");

    // Per-hash random salt. Without it, two users choosing the same password
    // would share a hash — so cracking one cracks both, and the database
    // itself reveals which accounts to attack together.
    expect(first).not.toBe(second);
    await expect(hasher.verify("same password", first)).resolves.toBe(true);
    await expect(hasher.verify("same password", second)).resolves.toBe(true);
  });

  it("encodes algorithm, parameters and salt into the hash", async () => {
    const encoded = await hasher.hash("whatever");

    // The self-describing PHC format is what makes parameter changes
    // survivable: an old hash carries the parameters it was made with, so it
    // stays verifiable after the defaults move.
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$/);
  });

  it("never stores the plaintext anywhere in the hash", async () => {
    const encoded = await hasher.hash("hunter2");

    expect(encoded).not.toContain("hunter2");
  });

  it("handles unicode and very long passwords without truncating", async () => {
    // bcrypt silently truncates at 72 bytes, turning a long passphrase into a
    // shorter one with no warning. argon2 has no such limit — this asserts
    // the difference rather than assuming it.
    const long = "🔐".repeat(50) + "-tail-that-must-still-matter";
    const encoded = await hasher.hash(long);

    await expect(hasher.verify(long, encoded)).resolves.toBe(true);
    await expect(hasher.verify(long.slice(0, -5), encoded)).resolves.toBe(false);
  });

  describe("verify on unusable input", () => {
    it("returns false rather than throwing on a malformed hash", async () => {
      await expect(hasher.verify("password", "not-a-hash")).resolves.toBe(false);
      await expect(hasher.verify("password", "")).resolves.toBe(false);
      await expect(hasher.verify("password", "$argon2id$garbage")).resolves.toBe(false);
    });

    it("returns false for a hash from an algorithm it cannot read", async () => {
      // A legacy bcrypt hash, as would exist after importing users from
      // another system. It must fail closed — never throw into a caller's
      // catch block where "couldn't check" is easily mistaken for "fine".
      const bcryptish = "$2b$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123";

      await expect(hasher.verify("password", bcryptish)).resolves.toBe(false);
    });
  });

  describe("needsRehash", () => {
    it("is false for a hash made with the current parameters", async () => {
      const encoded = await hasher.hash("password");

      expect(hasher.needsRehash(encoded)).toBe(false);
    });

    it("is true for a hash made with weaker parameters", async () => {
      const weak = new Argon2PasswordHasher({ memoryCost: 32, timeCost: 1, parallelism: 1 });
      const stronger = new Argon2PasswordHasher({ memoryCost: 256, timeCost: 2, parallelism: 1 });

      const oldHash = await weak.hash("password");

      // The upgrade path: cost parameters have to rise as hardware improves,
      // but existing hashes can't be recomputed without the plaintext. Login
      // is the only moment it's available, so that's when the upgrade happens.
      expect(stronger.needsRehash(oldHash)).toBe(true);
      // Still verifiable in the meantime — parameters travel with the hash.
      await expect(stronger.verify("password", oldHash)).resolves.toBe(true);
    });

    it("is false when the stored hash is STRONGER than current parameters", async () => {
      const strong = new Argon2PasswordHasher({ memoryCost: 256, timeCost: 2, parallelism: 1 });
      const weakened = new Argon2PasswordHasher({ memoryCost: 32, timeCost: 1, parallelism: 1 });

      const strongHash = await strong.hash("password");

      // The downgrade guard. If this returned true, lowering a parameter to
      // shed load would silently re-hash every password *down* to the weaker
      // setting as users logged in — degrading the whole system while looking
      // like routine maintenance. Only upgrades should propagate.
      expect(weakened.needsRehash(strongHash)).toBe(false);
    });

    it("is false for a hash it cannot read", () => {
      expect(hasher.needsRehash("not-a-hash")).toBe(false);
    });
  });

  describe("parameter validation", () => {
    it("rejects parameters that would silently weaken every password", () => {
      // Misconfiguration is the realistic failure mode, not a broken
      // algorithm — and a hasher running at 1 KiB is indistinguishable from
      // a correct one until someone dumps the database.
      expect(() => new Argon2PasswordHasher({ ...FAST, memoryCost: 1 })).toThrow(/memoryCost/);
      expect(() => new Argon2PasswordHasher({ ...FAST, timeCost: 0 })).toThrow(/timeCost/);
      expect(() => new Argon2PasswordHasher({ ...FAST, parallelism: 0 })).toThrow(/parallelism/);
    });
  });

  describe("cost at production parameters", () => {
    it("hashes at the configured cost, not a weaker one", async () => {
      const production = new Argon2PasswordHasher(DEFAULT_ARGON2_PARAMETERS);

      const started = performance.now();
      const digest = await production.hash("correct horse battery staple");
      const elapsed = performance.now() - started;

      // Slowness is the security property, so assert it by reading the cost parameters recorded in
      // the PHC string. A wall-clock bound failed on a fast CI runner.
      const { memoryCost, timeCost, parallelism } = DEFAULT_ARGON2_PARAMETERS;
      expect(digest).toContain(
        `$argon2id$v=19$m=${String(memoryCost)},t=${String(timeCost)},p=${String(parallelism)}$`,
      );

      // Kept only as a floor on "the KDF ran at all". Argon2id over 19 MiB
      // cannot finish in under a millisecond on any hardware, while a no-op
      // or a bare digest returns in microseconds. Loose enough that runner
      // speed cannot reach it.
      expect(elapsed).toBeGreaterThan(1);
    }, 30_000);
  });
});
