import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { UserRepository } from "../../../application/ports/user-repository.js";
import { User } from "../../../domain/entities/user.js";
import { DisplayName } from "../../../domain/value-objects/display-name.js";
import { Email } from "../../../domain/value-objects/email.js";

function makeUser(email: string): User {
  const emailResult = Email.create(email);
  const displayNameResult = DisplayName.create("Test User");
  if (!Result.isOk(emailResult) || !Result.isOk(displayNameResult)) {
    throw new Error("contract test fixture setup failed");
  }
  return User.register({ email: emailResult.value, displayName: displayNameResult.value });
}

/**
 * Behavioral contract every `UserRepository` implementation must satisfy —
 * run against `InMemoryUserRepository` today and, once it exists, the
 * Prisma-backed adapter from Phase 03, via the same test bodies. This is
 * **contract testing**: one shared suite, multiple implementations, each
 * proven to behave identically rather than merely "compile against the same
 * interface." See `docs/guides/testing.md`.
 */
export function userRepositoryContract(createRepository: () => UserRepository): void {
  describe("UserRepository contract", () => {
    it("returns undefined for a user that was never saved", async () => {
      const repository = createRepository();

      await expect(repository.findById(makeUser("nobody@example.com").id)).resolves.toBeUndefined();
    });

    it("finds a saved user by id", async () => {
      const repository = createRepository();
      const user = makeUser("alice@example.com");

      await repository.save(user);

      await expect(repository.findById(user.id)).resolves.toBe(user);
    });

    it("finds a saved user by email", async () => {
      const repository = createRepository();
      const user = makeUser("alice@example.com");

      await repository.save(user);

      await expect(repository.findByEmail(user.email)).resolves.toBe(user);
    });

    it("save is an idempotent upsert", async () => {
      const repository = createRepository();
      const user = makeUser("alice@example.com");

      await repository.save(user);
      const activated = user.activate();
      if (!Result.isOk(activated)) throw new Error("fixture setup failed");
      await repository.save(activated.value);

      const found = await repository.findById(user.id);
      expect(found?.status).toBe("active");
    });

    it("existsByEmail is true only after the matching user is saved", async () => {
      const repository = createRepository();
      const user = makeUser("alice@example.com");

      await expect(repository.existsByEmail(user.email)).resolves.toBe(false);
      await repository.save(user);
      await expect(repository.existsByEmail(user.email)).resolves.toBe(true);
    });
  });
}
