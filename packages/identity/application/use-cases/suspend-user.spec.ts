import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { RegisterUser } from "./register-user.js";
import { SuspendUser } from "./suspend-user.js";

describe("SuspendUser", () => {
  let repository: InMemoryUserRepository;
  let suspendUser: SuspendUser;

  beforeEach(() => {
    repository = new InMemoryUserRepository();
    suspendUser = new SuspendUser(repository);
  });

  it("returns NotFoundError for an unknown user", async () => {
    const result = await suspendUser.execute({
      userId: asId("00000000-0000-0000-0000-000000000001"),
      reason: "policy violation",
    });

    expect(Result.isErr(result) && result.error.code).toBe("NOT_FOUND");
  });

  it("requires a non-empty reason", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");
    const activated = registered.value.activate();
    if (!Result.isOk(activated)) throw new Error("fixture setup failed");
    await repository.save(activated.value);

    const result = await suspendUser.execute({ userId: activated.value.id, reason: "   " });

    expect(Result.isErr(result) && result.error.code).toBe("VALIDATION_ERROR");
  });

  it("suspends an active user and records the reason", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");
    const activated = registered.value.activate();
    if (!Result.isOk(activated)) throw new Error("fixture setup failed");
    await repository.save(activated.value);

    const result = await suspendUser.execute({
      userId: activated.value.id,
      reason: "policy violation",
    });

    expect(Result.isOk(result) && result.value.status).toBe("suspended");
    const persisted = await repository.findById(activated.value.id);
    expect(persisted?.status).toBe("suspended");
  });

  it("rejects suspending a pending user (invalid transition)", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const result = await suspendUser.execute({
      userId: registered.value.id,
      reason: "policy violation",
    });

    expect(Result.isErr(result)).toBe(true);
  });
});
