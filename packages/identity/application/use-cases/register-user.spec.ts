import { Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Email } from "../../domain/value-objects/email.js";
import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { RegisterUser } from "./register-user.js";

describe("RegisterUser", () => {
  let repository: InMemoryUserRepository;
  let registerUser: RegisterUser;

  beforeEach(() => {
    repository = new InMemoryUserRepository();
    registerUser = new RegisterUser(repository);
  });

  it("registers a new user and persists it", async () => {
    const result = await registerUser.execute({
      email: "alice@example.com",
      displayName: "Alice",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.email.value).toBe("alice@example.com");
      expect(result.value.status).toBe("pending");
      await expect(repository.findById(result.value.id)).resolves.toBe(result.value);
    }
  });

  it("registers a user with an optional person name", async () => {
    const result = await registerUser.execute({
      email: "alice@example.com",
      displayName: "Alice",
      givenName: "Alice",
      familyName: "Smith",
    });

    expect(Result.isOk(result) && result.value.personName?.toFullName()).toBe("Alice Smith");
  });

  it("rejects an invalid email without persisting anything", async () => {
    const result = await registerUser.execute({ email: "not-an-email", displayName: "Alice" });

    expect(Result.isErr(result)).toBe(true);

    const probeEmail = Email.create("alice@example.com");
    if (!Result.isOk(probeEmail)) throw new Error("fixture setup failed");
    await expect(repository.existsByEmail(probeEmail.value)).resolves.toBe(false);
  });

  it("rejects an invalid display name", async () => {
    const result = await registerUser.execute({ email: "alice@example.com", displayName: "" });

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a duplicate email without writing to the repository", async () => {
    const first = await registerUser.execute({ email: "alice@example.com", displayName: "Alice" });
    expect(Result.isOk(first)).toBe(true);

    const second = await registerUser.execute({
      email: "Alice@Example.com",
      displayName: "Alice Again",
    });

    expect(Result.isErr(second)).toBe(true);
    if (Result.isErr(second)) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });
});
