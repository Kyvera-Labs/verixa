import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { ReactivateUser } from "./reactivate-user.js";
import { RegisterUser } from "./register-user.js";
import { SuspendUser } from "./suspend-user.js";

describe("ReactivateUser", () => {
  let repository: InMemoryUserRepository;
  let reactivateUser: ReactivateUser;

  beforeEach(() => {
    repository = new InMemoryUserRepository();
    reactivateUser = new ReactivateUser(repository);
  });

  it("returns NotFoundError for an unknown user", async () => {
    const result = await reactivateUser.execute({
      userId: asId("00000000-0000-0000-0000-000000000001"),
      reason: "appeal approved",
    });

    expect(Result.isErr(result) && result.error.code).toBe("NOT_FOUND");
  });

  it("rejects reactivating a user that was never suspended", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const result = await reactivateUser.execute({
      userId: registered.value.id,
      reason: "appeal approved",
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
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
    const suspended = await new SuspendUser(repository).execute({
      userId: activated.value.id,
      reason: "policy violation",
    });
    if (!Result.isOk(suspended)) throw new Error("fixture setup failed");

    const result = await reactivateUser.execute({ userId: suspended.value.id, reason: "" });

    expect(Result.isErr(result) && result.error.code).toBe("VALIDATION_ERROR");
  });

  it("reactivates a suspended user", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");
    const activated = registered.value.activate();
    if (!Result.isOk(activated)) throw new Error("fixture setup failed");
    await repository.save(activated.value);
    const suspended = await new SuspendUser(repository).execute({
      userId: activated.value.id,
      reason: "policy violation",
    });
    if (!Result.isOk(suspended)) throw new Error("fixture setup failed");

    const result = await reactivateUser.execute({
      userId: suspended.value.id,
      reason: "appeal approved",
    });

    expect(Result.isOk(result) && result.value.status).toBe("active");
  });
});
