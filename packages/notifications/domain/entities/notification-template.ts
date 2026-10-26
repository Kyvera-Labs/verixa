import { Result, ValidationError } from "@verixa/shared-kernel";

/**
 * The delivery channels a template can target.
 *
 * Issue 261 owns the `NotificationChannel` value object; until it lands this
 * is the minimal shape a template needs, and Issue 261's type should replace
 * it rather than sit alongside it.
 */
export type NotificationChannel = "email" | "sms" | "webhook";

const CHANNELS: readonly NotificationChannel[] = ["email", "sms", "webhook"];

/**
 * Lowercase dot/dash-separated segments, e.g. `credentials.password-reset.email`.
 *
 * Keys are identifiers written by developers, not display text. A key that
 * differs only in case or surrounding whitespace is rejected instead of
 * normalized: normalizing would let `"Password-Reset"` and `"password-reset"`
 * silently become the same template, hiding a typo the registry should
 * surface at startup.
 */
const KEY_SEGMENT = /^[a-z0-9]+$/;

// Split-and-test rather than one pattern with a nested quantifier
// (`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`), which the security lint rule rejects.
// Same rule: an empty segment (a leading, trailing or doubled separator)
// fails, so `a..b`, `.a` and `a-` are all invalid.
function isValidKey(key: string): boolean {
  return key.split(/[.-]/).every((segment) => KEY_SEGMENT.test(segment));
}

/**
 * What a developer writes to define a template. The union makes the
 * compiler enforce "email has a subject, SMS and webhook don't" for
 * definitions written in TypeScript; {@link NotificationTemplate.create}
 * re-checks it at runtime for definitions that arrive any other way.
 */
export type NotificationTemplateDefinition =
  | {
      readonly key: string;
      readonly channel: "email";
      readonly subjectTemplate: string;
      readonly bodyTemplate: string;
      readonly requiredPayloadFields: readonly string[];
    }
  | {
      readonly key: string;
      readonly channel: "sms" | "webhook";
      readonly bodyTemplate: string;
      readonly requiredPayloadFields: readonly string[];
    };

/**
 * The content side of a notification: what it says, on which channel, and
 * which payload fields it needs to say it.
 *
 * A value object — two templates with the same fields are interchangeable,
 * and it has no lifecycle, so there is no `reconstitute`. The trigger side
 * (which domain event causes which notification) refers to a template only
 * by `key`, which is what lets content change without touching use-case
 * code. Rendering `subjectTemplate`/`bodyTemplate` against a payload is
 * Issue 265's job; this type only guarantees the definition is complete.
 */
export class NotificationTemplate {
  readonly key: string;
  readonly channel: NotificationChannel;
  /** `null` on channels with no subject line (SMS, webhook). */
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
  readonly requiredPayloadFields: readonly string[];

  private constructor(props: {
    key: string;
    channel: NotificationChannel;
    subjectTemplate: string | null;
    bodyTemplate: string;
    requiredPayloadFields: readonly string[];
  }) {
    this.key = props.key;
    this.channel = props.channel;
    this.subjectTemplate = props.subjectTemplate;
    this.bodyTemplate = props.bodyTemplate;
    this.requiredPayloadFields = Object.freeze([...props.requiredPayloadFields]);
  }

  /**
   * Validates a definition, reporting every problem at once rather than the
   * first — a developer fixing a broken template set at startup should not
   * have to restart once per mistake.
   */
  static create(
    definition: NotificationTemplateDefinition,
  ): Result<NotificationTemplate, ValidationError> {
    // Read through an untyped view: the union already rules these cases out
    // at compile time, so checking them needs a shape the compiler allows.
    const raw = definition as unknown as Record<string, unknown>;
    const { key, channel, subjectTemplate, bodyTemplate, requiredPayloadFields } = raw;

    const fieldErrors: Record<string, string[]> = {};

    if (typeof key !== "string" || key.length === 0) {
      fieldErrors["key"] = ["required"];
    } else if (!isValidKey(key)) {
      fieldErrors["key"] = ["invalid_format"];
    }

    const knownChannel = CHANNELS.find((candidate) => candidate === channel);
    if (knownChannel === undefined) {
      fieldErrors["channel"] = ["invalid"];
    }

    if (knownChannel === "email") {
      if (!isNonBlankString(subjectTemplate)) {
        fieldErrors["subjectTemplate"] = ["required"];
      }
    } else if (knownChannel !== undefined && subjectTemplate !== undefined) {
      // A subject on SMS would be silently dropped at send time. Rejecting it
      // here turns "why is my subject missing?" into a startup error.
      fieldErrors["subjectTemplate"] = ["not_supported"];
    }

    if (!isNonBlankString(bodyTemplate)) {
      fieldErrors["bodyTemplate"] = ["required"];
    }

    if (!Array.isArray(requiredPayloadFields)) {
      fieldErrors["requiredPayloadFields"] = ["required"];
    } else if (!requiredPayloadFields.every(isNonBlankString)) {
      fieldErrors["requiredPayloadFields"] = ["invalid_entry"];
    } else if (new Set(requiredPayloadFields).size !== requiredPayloadFields.length) {
      fieldErrors["requiredPayloadFields"] = ["duplicate"];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Notification template is invalid.", fieldErrors));
    }

    return Result.ok(
      new NotificationTemplate({
        key: key as string,
        channel: knownChannel as NotificationChannel,
        subjectTemplate: knownChannel === "email" ? (subjectTemplate as string) : null,
        bodyTemplate: bodyTemplate as string,
        requiredPayloadFields: requiredPayloadFields as string[],
      }),
    );
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
