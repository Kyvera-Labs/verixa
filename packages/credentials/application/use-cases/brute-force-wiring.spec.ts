import {
  BruteForcePolicy,
  InMemoryBruteForceAttemptStore,
  NoopRateLimiter,
  Result,
} from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { PasswordResetToken } from "../../domain/entities/password-reset-token.js";
import { DEFAULT_LOCKOUT_POLICY } from "../../domain/value-objects/lockout-policy.js";
import { Argon2PasswordHasher } from "../../infrastructure/argon2-password-hasher.js";
import { InMemoryCredentialsUnitOfWork } from "../../infrastructure/testing/in-memory-credentials-unit-of-work.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";

import { AuthenticateWithPassword } from "./authenticate-with-password.js";
import { ConfirmPasswordReset } from "./confirm-password-reset.js";
import { RegisterUserWithPassword } from "./register-user-with-password.js";

// Weak parameters: these tests are about which attempts reach the database,
// not about hashing strength.
const FAST = { memoryCost: 64, timeCost: 1, parallelism: 1 };

const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a sufficiently long replacement secret";

/**
 * Wraps a unit of work to count how many times the use case reaches it.
 *
 * The assertion this exists for is a negative one: a request refused by the
 * gate must not perform the lookup. Counting transactions is the only way to
 * say that from outside, and it is the property that makes the gate worth
 * having — the throttled path is the one that stops spending.
 */
function countingUnitOfWork(inner: CredentialsUnitOfWork) {
  let runs = 0;
  const unit: CredentialsUnitOfWork = {
    run(work) {
      runs += 1;
      return inner.run(work);
    },
  };
  return {
    get runs() {
      return runs;
    },
    unit,
  };
}

describe("AuthenticateWithPassword with a brute-force gate", () => {
  let unitOfWork: InMemoryCredentialsUnitOfWork;
  let store: InMemoryBruteForceAttemptStore;

  beforeEach(async () => {
    unitOfWork = new InMemoryCredentialsUnitOfWork();
    store = new InMemoryBruteForceAttemptStore();

    const hasher = new Argon2PasswordHasher(FAST);
    const registered = await new RegisterUserWithPassword(
      unitOfWork,
      hasher,
      new NoopRateLimiter(),
    ).execute({
      email: EMAIL,
      displayName: "Alice",
      password: PASSWORD,
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");
  });

  function login(threshold: number) {
    const counting = countingUnitOfWork(unitOfWork);
    const useCase = new AuthenticateWithPassword(
      counting.unit,
      new Argon2PasswordHasher(FAST),
      new NoopRateLimiter(),
      DEFAULT_LOCKOUT_POLICY,
      undefined,
      new BruteForcePolicy(store, { threshold }),
    );
    return { counting, useCase };
  }

  it("throttles probes against addresses that have no account", async () => {
    // This is the gap the gate exists to close. A probe against an unknown
    // address advances nothing in the database — there is no row to record a
    // failure against — so a per-credential lockout cannot see an enumeration
    // run at all. Here it can.
    const { useCase } = login(3);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await useCase.execute({ email: "nobody@example.com", password: "guess" });
      expect(Result.isErr(result)).toBe(true);
    }

    const record = await store.read(BruteForcePolicy.key("login", "nobody@example.com"));
    expect(record.failedAttempts).toBe(3);
    expect(record.lockedUntil).not.toBeNull();
  });

  it("refuses without reaching the database, and says the same thing", async () => {
    const { counting, useCase } = login(2);

    await useCase.execute({ email: "nobody@example.com", password: "guess" });
    await useCase.execute({ email: "nobody@example.com", password: "guess" });
    const runsBeforeRefusal = counting.runs;

    const refused = await useCase.execute({ email: "nobody@example.com", password: "guess" });

    // Indistinguishable from any other failed login: same code, same message.
    // A refusal that announced itself would answer "does this address exist",
    // which is what the rest of this use case works to hide.
    expect(Result.isErr(refused)).toBe(true);
    if (!Result.isOk(refused)) {
      expect(refused.error.code).toBe("AUTHENTICATION_FAILED");
      expect(refused.error.message).toBe("Invalid email or password.");
    }
    // The gate fired first, so the lookup never happened.
    expect(counting.runs).toBe(runsBeforeRefusal);
  });

  it("does not double-count a wrong password the credential already counts", async () => {
    // A real account with a wrong password is the case the row-level lockout
    // handles, and it has the stricter property: the counter is durable and
    // belongs to the account. Recording the same failure here too would give it
    // two penalties and make the effective threshold unknowable.
    const { counting, useCase } = login(2);

    for (const password of ["wrong one", "wrong two", "wrong three"]) {
      const result = await useCase.execute({ email: EMAIL, password });
      expect(Result.isErr(result)).toBe(true);
    }

    // Every attempt reached the row, and none of them moved the shared budget.
    expect(counting.runs).toBe(3);
    expect((await store.read(BruteForcePolicy.key("login", EMAIL))).failedAttempts).toBe(0);
  });

  it("leaves other accounts usable while one budget is exhausted", async () => {
    const { useCase } = login(2);

    await useCase.execute({ email: "nobody@example.com", password: "guess" });
    await useCase.execute({ email: "nobody@example.com", password: "guess" });

    // Per-identifier, not global. A gate that closed the endpoint after two bad
    // guesses from anyone would be a denial of service against every customer,
    // a worse outcome than the guessing it prevents.
    const ok = await useCase.execute({ email: EMAIL, password: PASSWORD });
    expect(Result.isOk(ok)).toBe(true);
  });

  it("clears the budget when the owner signs in", async () => {
    const { useCase } = login(5);
    const key = BruteForcePolicy.key("login", EMAIL);
    // Seeded directly: an address with a credential has its failures counted by
    // the row, so the only way to observe the reset is to put a budget in the
    // state a prior enumeration run against this address would have left it in.
    await store.recordFailure(key, null);

    const ok = await useCase.execute({ email: EMAIL, password: PASSWORD });

    expect(Result.isOk(ok)).toBe(true);
    expect((await store.read(key)).failedAttempts).toBe(0);
  });
});

describe("ConfirmPasswordReset with a brute-force gate", () => {
  const TOKEN = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

  function reset(threshold: number) {
    const store = new InMemoryBruteForceAttemptStore();
    const counting = countingUnitOfWork(new InMemoryCredentialsUnitOfWork());
    const useCase = new ConfirmPasswordReset(
      counting.unit,
      new Argon2PasswordHasher(FAST),
      { revokeAllForUser: () => Promise.resolve() },
      new NoopRateLimiter(),
      undefined,
      undefined,
      new BruteForcePolicy(store, { threshold }),
    );
    return { counting, store, useCase };
  }

  it("counts guesses against one token and stops looking it up", async () => {
    const { counting, store, useCase } = reset(2);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await useCase.execute({ token: TOKEN, newPassword: NEW_PASSWORD });
      expect(Result.isErr(result)).toBe(true);
      if (!Result.isOk(result)) {
        // Same message and same field errors every time, including once the
        // gate is shut. "Too many attempts" would confirm a real link exists.
        expect(result.error.message).toBe("This reset link is not valid.");
        expect(result.error.fieldErrors).toEqual({ token: ["invalid"] });
      }
    }

    const record = await store.read(
      BruteForcePolicy.key("password-reset", PasswordResetToken.hashToken(TOKEN)),
    );
    // Two failures, not three: the third was refused before the lookup, so it
    // never touched the token store.
    expect(record.failedAttempts).toBe(2);
    expect(record.lockedUntil).not.toBeNull();
    expect(counting.runs).toBe(2);
  });

  it("does not count a password that fails the policy before the token is reached", async () => {
    // Password validation runs first, so a too-short new password never
    // consumes the reset budget. Asserting the counter stays at zero is what
    // keeps "your password was too weak" from becoming a way to lock yourself
    // out of your own reset.
    const { counting, store, useCase } = reset(2);
    const key = BruteForcePolicy.key("password-reset", PasswordResetToken.hashToken(TOKEN));

    for (const newPassword of ["short", "also short"]) {
      const result = await useCase.execute({ token: TOKEN, newPassword });
      expect(Result.isErr(result)).toBe(true);
      if (!Result.isOk(result))
        expect(result.error.message).not.toBe("This reset link is not valid.");
    }

    expect((await store.read(key)).failedAttempts).toBe(0);
    expect(counting.runs).toBe(0);
  });
});
