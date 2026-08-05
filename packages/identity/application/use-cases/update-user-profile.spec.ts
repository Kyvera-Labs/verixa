import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { RegisterUser } from "./register-user.js";
import { UpdateUserProfile } from "./update-user-profile.js";

describe("UpdateUserProfile", () => {
  let repository: InMemoryUserRepository;
  let updateUserProfile: UpdateUserProfile;

  beforeEach(() => {
    repository = new InMemoryUserRepository();
    updateUserProfile = new UpdateUserProfile(repository);
  });

  it("returns NotFoundError for an unknown user", async () => {
    const result = await updateUserProfile.execute({
      userId: asId("00000000-0000-0000-0000-000000000001"),
      displayName: "Alicia",
    });

    expect(Result.isErr(result) && result.error.code).toBe("NOT_FOUND");
  });

  it("updates only the display name when that's all that's provided", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const result = await updateUserProfile.execute({
      userId: registered.value.id,
      displayName: "Alicia",
    });

    expect(Result.isOk(result) && result.value.displayName.value).toBe("Alicia");
    expect(Result.isOk(result) && result.value.personName).toBeUndefined();
  });

  it("updates the person name when given/family name are provided", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const result = await updateUserProfile.execute({
      userId: registered.value.id,
      givenName: "Alice",
      familyName: "Smith",
    });

    expect(Result.isOk(result) && result.value.personName?.toFullName()).toBe("Alice Smith");
    // displayName untouched since it wasn't part of this command.
    expect(Result.isOk(result) && result.value.displayName.value).toBe("Alice");
  });

  it("aggregates field errors across multiple invalid fields", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const result = await updateUserProfile.execute({
      userId: registered.value.id,
      displayName: "",
      givenName: "",
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result) && result.error instanceof Error && "fieldErrors" in result.error) {
      const fieldErrors = result.error.fieldErrors as Record<string, string[]>;
      expect(fieldErrors["displayName"]).toContain("required");
      expect(fieldErrors["givenName"]).toContain("required");
    }
  });

  it("persists the updated user", async () => {
    const registered = await new RegisterUser(repository).execute({
      email: "alice@example.com",
      displayName: "Alice",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    await updateUserProfile.execute({ userId: registered.value.id, displayName: "Alicia" });

    const persisted = await repository.findById(registered.value.id);
    expect(persisted?.displayName.value).toBe("Alicia");
  });
});
