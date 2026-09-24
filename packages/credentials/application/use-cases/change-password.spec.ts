import type { User } from "@verixa/identity";
import { Result, asId } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Argon2PasswordHasher } from "../../infrastructure/argon2-password-hasher.js";
import { InMemoryCredentialsUnitOfWork } from "../../infrastructure/testing/in-memory-credentials-unit-of-work.js";

import { ChangePassword } from "./change-password.js";
import { RegisterUserWithPassword } from "./register-user-with-password.js";

// Weak parameters, for the same reason the authentication specs use them: these
// tests exercise orchestration and correctness, not hashing strength. The
// hasher's own spec covers production parameters.
const FAST = { memoryCost: 64, timeCost: 1, parallelism: 1 };

const EMAIL = "alice@example.com";
const CURRENT_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "new correct horse battery staple";

describe("ChangePassword", () => {
  let unitOfWork: InMemoryCredentialsUnitOfWork;
  let hasher: Argon2PasswordHasher;
  let register: RegisterUserWithPassword;
  let changePassword: ChangePassword;
  let registeredUser: User;

  beforeEach(async () => {
    unitOfWork = new InMemoryCredentialsUnitOfWork();
    // A fresh hasher per test, because the decoy hash is cached per hasher
    // instance. Sharing one would affect timing tests and result measurements.
    hasher = new Argon2PasswordHasher(FAST);
    register = new RegisterUserWithPassword(unitOfWork, hasher);
    changePassword = new ChangePassword(unitOfWork, hasher);

    // Fixture: register a user with the current password
    const registered = await register.execute({
      email: EMAIL,
      displayName: "Alice",
      password: CURRENT_PASSWORD,
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");
    registeredUser = registered.value.user;
  });

  describe("success", () => {
    it("changes password when current password is correct", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isOk(result)).toBe(true);
      if (!Result.isOk(result)) return;
       
      expect(result.value.user.id).toBe(registeredUser.id);
    });

    it("returns the authenticated user", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isOk(result)).toBe(true);
      if (!Result.isOk(result)) return;
       
      expect(result.value.user.email.value).toBe(EMAIL);
       
      expect(result.value.user.status).toBe("pending");
    });

    it("stores the new password (can authenticate with it)", async () => {
      // Change the password
      const changeResult = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(Result.isOk(changeResult)).toBe(true);

      // Attempt to authenticate with the new password
      const { AuthenticateWithPassword } = await import("./authenticate-with-password.js");
      const authenticate = new AuthenticateWithPassword(unitOfWork, hasher);
      const authResult = await authenticate.execute({
        email: EMAIL,
        password: NEW_PASSWORD,
      });

      expect(Result.isOk(authResult)).toBe(true);
      if (!Result.isOk(authResult)) return;
      expect(authResult.value.user.email.value).toBe(EMAIL);
    });

    it("old password no longer works after change", async () => {
      // Change the password
      const changeResult = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(Result.isOk(changeResult)).toBe(true);

      // Attempt to authenticate with the old password
      const { AuthenticateWithPassword } = await import("./authenticate-with-password.js");
      const authenticate = new AuthenticateWithPassword(unitOfWork, hasher);
      const authResult = await authenticate.execute({
        email: EMAIL,
        password: CURRENT_PASSWORD,
      });

      expect(Result.isErr(authResult)).toBe(true);
    });
  });

  describe("does not change password", () => {
    it("rejects when current password is wrong", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: "wrong password entirely",
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects when new password is too short", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: "short",
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects when new password is empty", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: "",
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns the same error for missing user and wrong password", async () => {
      const missingUserResult = await changePassword.execute({
        userId: asId<"UserId">("nonexistent-user-id"),
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      const wrongPasswordResult = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: "wrong password",
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isErr(missingUserResult)).toBe(true);
      expect(Result.isErr(wrongPasswordResult)).toBe(true);
      if (Result.isErr(missingUserResult) && Result.isErr(wrongPasswordResult)) {
        // Both should be VALIDATION_ERROR with the same message, preventing
        // enumeration: a caller cannot tell whether the user exists or the
        // password is wrong.
        expect(missingUserResult.error.code).toBe(wrongPasswordResult.error.code);
        expect(missingUserResult.error.message).toBe(wrongPasswordResult.error.message);
      }
    });

    it("error for wrong password identifies the currentPassword field", async () => {
      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: "wrong",
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      // ValidationError has a fieldErrors object keyed by field name
      expect(result.error.fieldErrors?.currentPassword).toBeDefined();
    });
  });

  describe("lockout clearing", () => {
    it("clears lockout after successful password change", async () => {
      // Cause failed login attempts to lock the credential
      const { AuthenticateWithPassword } = await import("./authenticate-with-password.js");
      const authenticate = new AuthenticateWithPassword(unitOfWork, hasher);

      // Default policy locks after 5 failures
      for (let i = 0; i < 5; i++) {
        await authenticate.execute({
          email: EMAIL,
          password: "wrong",
        });
      }

      // At this point, the credential should be locked
      const lockedResult = await authenticate.execute({
        email: EMAIL,
        password: CURRENT_PASSWORD,
      });
      expect(Result.isErr(lockedResult)).toBe(true);

      // Change the password
      const changeResult = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(Result.isOk(changeResult)).toBe(true);

      // Should now be able to authenticate with the new password
      const nowUnlockedResult = await authenticate.execute({
        email: EMAIL,
        password: NEW_PASSWORD,
      });
      expect(Result.isOk(nowUnlockedResult)).toBe(true);
    });
  });

  describe("does not revoke sessions", () => {
    it("change-password does not revoke sessions (unlike password-reset)", async () => {
      // This is a documented difference: password reset revokes sessions
      // (address "someone else has my account"), but change-password does not
      // (user is already authenticated and owns their session).
      //
      // This test documents the behavior. In a full integration test with
      // actual sessions (Phase 05+), we would verify that the session remains
      // valid after a password change.

      const result = await changePassword.execute({
        userId: registeredUser.id,
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      // No error should be returned about session revocation
      expect(Result.isOk(result)).toBe(true);
    });
  });
});
