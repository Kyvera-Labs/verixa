import { Result, ValidationError } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import {
  NotificationTemplate,
  type NotificationTemplateDefinition,
} from "./notification-template.js";

const emailDefinition: NotificationTemplateDefinition = {
  key: "credentials.password-reset.email",
  channel: "email",
  subjectTemplate: "Reset your password",
  bodyTemplate: "Follow {{resetLink}} to choose a new password.",
  requiredPayloadFields: ["resetLink"],
};

/** Runtime-shaped input, for definitions the compiler would otherwise reject. */
function loose(definition: Record<string, unknown>): NotificationTemplateDefinition {
  return definition as unknown as NotificationTemplateDefinition;
}

/** A copy of `definition` with `field` removed entirely (not set to undefined). */
function without(
  definition: NotificationTemplateDefinition,
  field: string,
): NotificationTemplateDefinition {
  const copy: Record<string, unknown> = { ...definition };
  delete copy[field];
  return loose(copy);
}

function expectFieldErrors(
  result: Result<NotificationTemplate, ValidationError>,
): Readonly<Record<string, readonly string[]>> {
  if (Result.isOk(result)) throw new Error("expected template creation to fail");
  expect(result.error).toBeInstanceOf(ValidationError);
  return result.error.fieldErrors;
}

describe("NotificationTemplate.create", () => {
  it("builds an email template with subject, body and required payload fields", () => {
    const result = NotificationTemplate.create(emailDefinition);

    if (!Result.isOk(result)) throw result.error;
    expect(result.value.key).toBe("credentials.password-reset.email");
    expect(result.value.channel).toBe("email");
    expect(result.value.subjectTemplate).toBe("Reset your password");
    expect(result.value.bodyTemplate).toBe("Follow {{resetLink}} to choose a new password.");
    expect(result.value.requiredPayloadFields).toEqual(["resetLink"]);
  });

  it.each(["sms", "webhook"] as const)("builds a %s template with no subject", (channel) => {
    const result = NotificationTemplate.create({
      key: `security.new-login.${channel}`,
      channel,
      bodyTemplate: "New sign-in from {{location}}.",
      requiredPayloadFields: ["location"],
    });

    if (!Result.isOk(result)) throw result.error;
    expect(result.value.channel).toBe(channel);
    expect(result.value.subjectTemplate).toBeNull();
  });

  it("does not let a caller mutate requiredPayloadFields after construction", () => {
    const fields = ["resetLink"];
    const result = NotificationTemplate.create({
      ...emailDefinition,
      requiredPayloadFields: fields,
    });
    if (!Result.isOk(result)) throw result.error;

    fields.push("injected");

    expect(result.value.requiredPayloadFields).toEqual(["resetLink"]);
    expect(Object.isFrozen(result.value.requiredPayloadFields)).toBe(true);
  });

  it("rejects an email template without a subject", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create(without(emailDefinition, "subjectTemplate")),
    );

    expect(errors).toEqual({ subjectTemplate: ["required"] });
  });

  it("rejects a whitespace-only subject on an email template", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create({ ...emailDefinition, subjectTemplate: "   " }),
    );

    expect(errors).toEqual({ subjectTemplate: ["required"] });
  });

  it("rejects a subject on a channel that has nowhere to put it", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create(
        loose({
          key: "security.new-login.sms",
          channel: "sms",
          subjectTemplate: "Ignored on SMS",
          bodyTemplate: "New sign-in.",
          requiredPayloadFields: [],
        }),
      ),
    );

    expect(errors).toEqual({ subjectTemplate: ["not_supported"] });
  });

  it("rejects a missing or blank body", () => {
    expect(
      expectFieldErrors(NotificationTemplate.create(without(emailDefinition, "bodyTemplate"))),
    ).toEqual({ bodyTemplate: ["required"] });
    expect(
      expectFieldErrors(NotificationTemplate.create({ ...emailDefinition, bodyTemplate: "" })),
    ).toEqual({ bodyTemplate: ["required"] });
  });

  it("rejects a missing key", () => {
    const errors = expectFieldErrors(NotificationTemplate.create({ ...emailDefinition, key: "" }));

    expect(errors).toEqual({ key: ["required"] });
  });

  it.each(["Password-Reset", "password reset", " password-reset", "password..reset", "-reset"])(
    "rejects the malformed key %j rather than normalizing it",
    (key) => {
      const errors = expectFieldErrors(NotificationTemplate.create({ ...emailDefinition, key }));

      expect(errors).toEqual({ key: ["invalid_format"] });
    },
  );

  it("rejects an unknown channel", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create(loose({ ...emailDefinition, channel: "pigeon" })),
    );

    expect(errors).toEqual({ channel: ["invalid"] });
  });

  it("rejects a missing requiredPayloadFields list", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create(without(emailDefinition, "requiredPayloadFields")),
    );

    expect(errors).toEqual({ requiredPayloadFields: ["required"] });
  });

  it("rejects blank and duplicate entries in requiredPayloadFields", () => {
    expect(
      expectFieldErrors(
        NotificationTemplate.create({
          ...emailDefinition,
          requiredPayloadFields: ["resetLink", " "],
        }),
      ),
    ).toEqual({ requiredPayloadFields: ["invalid_entry"] });

    expect(
      expectFieldErrors(
        NotificationTemplate.create({
          ...emailDefinition,
          requiredPayloadFields: ["resetLink", "resetLink"],
        }),
      ),
    ).toEqual({ requiredPayloadFields: ["duplicate"] });
  });

  it("reports every problem at once instead of stopping at the first", () => {
    const errors = expectFieldErrors(
      NotificationTemplate.create(
        loose({ key: "", channel: "email", bodyTemplate: "", requiredPayloadFields: [] }),
      ),
    );

    expect(errors).toEqual({
      key: ["required"],
      subjectTemplate: ["required"],
      bodyTemplate: ["required"],
    });
  });
});
