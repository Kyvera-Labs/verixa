import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { User, type UserId } from "../../domain/entities/user.js";
import { DisplayName } from "../../domain/value-objects/display-name.js";
import { Email } from "../../domain/value-objects/email.js";
import { InMemoryUserRepository } from "../../infrastructure/testing/in-memory-user-repository.js";

import { GetUser } from "./get-user.js";

function unwrap<T>(result: Result<T, unknown>): T {
  if (!Result.isOk(result)) {
    throw new Error("Fixture unwrapping failed");
  }
  return result.value;
}

describe("GetUser", () => {
  let userRepo: InMemoryUserRepository;
  let getUser: GetUser;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    getUser = new GetUser(userRepo);
  });

  it("returns user when found", async () => {
    const user = User.register({
      email: unwrap(Email.create("alice@example.com")),
      displayName: unwrap(DisplayName.create("Alice")),
    });
    await userRepo.save(user);

    const result = await getUser.execute({ id: user.id });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toBeDefined();
    expect(Result.isOk(result) && result.value?.id).toBe(user.id);
  });

  it("returns undefined when user does not exist", async () => {
    const missingId: UserId = asId("00000000-0000-0000-0000-000000000099");
    const result = await getUser.execute({ id: missingId });

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toBeUndefined();
  });
});
