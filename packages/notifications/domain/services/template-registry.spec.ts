import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { NotificationTemplateDefinition } from "../entities/notification-template.js";

import { TemplateRegistry } from "./template-registry.js";

const passwordResetEmail: NotificationTemplateDefinition = {
  key: "credentials.password-reset.email",
  channel: "email",
  subjectTemplate: "Reset your password",
  bodyTemplate: "Follow {{resetLink}} to choose a new password.",
  requiredPayloadFields: ["resetLink"],
};

const newLoginSms: NotificationTemplateDefinition = {
  key: "security.new-login.sms",
  channel: "sms",
  bodyTemplate: "New sign-in from {{location}}.",
  requiredPayloadFields: ["location"],
};

function expectRegistryErrors(
  result: Result<TemplateRegistry, ValidationError>,
): Readonly<Record<string, readonly string[]>> {
  if (Result.isOk(result)) throw new Error("expected registry creation to fail");
  expect(result.error).toBeInstanceOf(ValidationError);
  return result.error.fieldErrors;
}

describe("TemplateRegistry", () => {
  describe("registration", () => {
    it("registers every valid definition and resolves each by key", () => {
      const result = TemplateRegistry.create([passwordResetEmail, newLoginSms]);
      if (!Result.isOk(result)) throw result.error;
      const registry = result.value;

      expect(registry.keys).toEqual(["credentials.password-reset.email", "security.new-login.sms"]);

      const email = registry.resolve("credentials.password-reset.email");
      if (!Result.isOk(email)) throw email.error;
      expect(email.value.channel).toBe("email");
      expect(email.value.subjectTemplate).toBe("Reset your password");

      const sms = registry.resolve("security.new-login.sms");
      if (!Result.isOk(sms)) throw sms.error;
      expect(sms.value.bodyTemplate).toBe("New sign-in from {{location}}.");
      expect(sms.value.requiredPayloadFields).toEqual(["location"]);
    });

    it("accepts an empty set of definitions", () => {
      const result = TemplateRegistry.create([]);

      if (!Result.isOk(result)) throw result.error;
      expect(result.value.keys).toEqual([]);
    });
  });

  describe("duplicate rejection", () => {
    it("rejects two definitions sharing a key, even when their content differs", () => {
      const errors = expectRegistryErrors(
        TemplateRegistry.create([
          passwordResetEmail,
          newLoginSms,
          { ...passwordResetEmail, subjectTemplate: "A different subject" },
        ]),
      );

      expect(errors).toEqual({ "credentials.password-reset.email": ["duplicate_key"] });
    });

    it("reports a key duplicated three times once, not twice", () => {
      const errors = expectRegistryErrors(
        TemplateRegistry.create([passwordResetEmail, passwordResetEmail, passwordResetEmail]),
      );

      expect(errors).toEqual({ "credentials.password-reset.email": ["duplicate_key"] });
    });
  });

  describe("missing-field validation", () => {
    it("rejects the whole registry when one definition is missing a required field", () => {
      const withoutSubject: Record<string, unknown> = { ...passwordResetEmail };
      delete withoutSubject["subjectTemplate"];

      const errors = expectRegistryErrors(
        TemplateRegistry.create([
          withoutSubject as unknown as NotificationTemplateDefinition,
          newLoginSms,
        ]),
      );

      expect(errors).toEqual({
        "credentials.password-reset.email": ["subjectTemplate:required"],
      });
    });

    it("identifies a definition with no usable key by its position", () => {
      const errors = expectRegistryErrors(
        TemplateRegistry.create([newLoginSms, { ...passwordResetEmail, key: "" }]),
      );

      expect(errors).toEqual({ "templates[1]": ["key:required"] });
    });

    it("collects every invalid and duplicate definition in a single error", () => {
      const errors = expectRegistryErrors(
        TemplateRegistry.create([
          passwordResetEmail,
          passwordResetEmail,
          { ...newLoginSms, bodyTemplate: " ", requiredPayloadFields: ["location", "location"] },
        ]),
      );

      expect(errors).toEqual({
        "credentials.password-reset.email": ["duplicate_key"],
        "security.new-login.sms": ["bodyTemplate:required", "requiredPayloadFields:duplicate"],
      });
    });
  });

  describe("lookup", () => {
    const registry = (() => {
      const result = TemplateRegistry.create([passwordResetEmail, newLoginSms]);
      if (!Result.isOk(result)) throw result.error;
      return result.value;
    })();

    it("fails with NotFoundError for an unregistered key", () => {
      const result = registry.resolve("credentials.email-verification.email");

      if (Result.isOk(result)) throw new Error("expected lookup to fail");
      expect(result.error).toBeInstanceOf(NotFoundError);
      expect(result.error.message).toContain("credentials.email-verification.email");
    });

    it("matches keys exactly rather than case- or whitespace-insensitively", () => {
      expect(Result.isOk(registry.resolve("Security.New-Login.SMS"))).toBe(false);
      expect(Result.isOk(registry.resolve(" security.new-login.sms"))).toBe(false);
    });

    it("reports membership through has()", () => {
      expect(registry.has("security.new-login.sms")).toBe(true);
      expect(registry.has("security.unknown.sms")).toBe(false);
    });

    it("does not let a caller grow the key list it hands out", () => {
      expect(() => (registry.keys as string[]).push("smuggled")).toThrow(TypeError);
      expect(registry.has("smuggled")).toBe(false);
    });
  });
});
