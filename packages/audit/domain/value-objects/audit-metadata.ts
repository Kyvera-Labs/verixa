import { Result, ValidationError } from "@verixa/shared-kernel";

/**
 * Why a metadata bag was replaced rather than recorded as supplied.
 *
 * The key is unlikely to collide with real metadata, and its value is one of a
 * closed set of reasons, so a query for "entries whose metadata was rejected"
 * finds them all. See `RecordAuditEvent`, which keeps the entry and swaps the
 * bag rather than dropping the record.
 */
export const METADATA_REJECTED_KEY = "metadataRejected";

/** Why {@link AuditMetadata.create} refused a bag. */
export type AuditMetadataRejectionReason =
  | "too_many_fields"
  | "empty_key"
  | "key_too_long"
  | "non_string_value"
  | "value_too_long"
  | "unclassified";

/**
 * Recovers the rejection reason from a `ValidationError` returned by {@link AuditMetadata.create},
 * so callers never string-match the message. Errors from elsewhere map to `unclassified`.
 */
export function rejectionReasonOf(error: ValidationError): AuditMetadataRejectionReason {
  const [reason] = error.fieldErrors.metadata ?? [];

  switch (reason) {
    case "too_many_fields":
    case "empty_key":
    case "key_too_long":
    case "non_string_value":
    case "value_too_long":
      return reason;
    default:
      return "unclassified";
  }
}

/**
 * Bounds on a metadata bag, and the reason each one is where it is.
 *
 * These are not a size policy for the sake of tidiness. Every limit here is
 * what makes an assertion about *output* possible: a CSV cell, a log record,
 * and a hash pre-image all have to be finished sometime, and "unbounded string
 * you plan to embed in all three" is how the guarantees in this file stop
 * holding.
 */
export const MAX_METADATA_ENTRIES = 32;
export const MAX_METADATA_KEY_LENGTH = 64;
export const MAX_METADATA_VALUE_LENGTH = 1024;

/**
 * Audit metadata checked to be bounded and string-valued, with safe renderings for every textual
 * sink.
 *
 * Metadata is usually attacker-controlled. Unhandled, it enables log forgery (a newline starts a
 * fake log line), CSV damage (commas, quotes or `\r\n` add cells or rows), spreadsheet formula
 * execution (cells starting with `=`, `+`, `-` or `@`) and digest ambiguity (a separator inside a
 * value makes two entries hash alike).
 *
 * Values are stored verbatim and neutralized at each output boundary: JSON for storage and export,
 * quoted and escaped CSV cells, and a length-prefixed hash pre-image. Sanitizing on input was
 * rejected because it rewrites the evidence and makes safety depend on stored data rather than on
 * each encoder.
 */
export class AuditMetadata {
  readonly #values: Readonly<Record<string, string>>;

  private constructor(values: Readonly<Record<string, string>>) {
    this.#values = Object.freeze({ ...values });
  }

  /**
   * Validates metadata arriving from outside the domain.
   *
   * Values must already be strings. Coercing numbers and booleans would make
   * `true` and `"true"` indistinguishable in a query, and silently accepting a
   * nested object means `JSON.stringify`-shaped data ends up inside a column
   * that every other reader expects to be flat.
   */
  static create(input: Readonly<Record<string, unknown>>): Result<AuditMetadata, ValidationError> {
    const keys = Object.keys(input);

    if (keys.length > MAX_METADATA_ENTRIES) {
      // The offending key list is deliberately not attached: an oversized bag is
      // exactly the input whose size this bound exists to contain, and the
      // caller already holds it.
      return Result.err(
        new ValidationError(
          `Audit metadata may not exceed ${String(MAX_METADATA_ENTRIES)} fields.`,
          { metadata: ["too_many_fields"] },
        ),
      );
    }

    const values: Record<string, string> = {};

    for (const key of keys) {
      if (key.length === 0) {
        return Result.err(
          new ValidationError("Audit metadata keys may not be empty.", {
            metadata: ["empty_key"],
          }),
        );
      }

      if (key.length > MAX_METADATA_KEY_LENGTH) {
        return Result.err(
          new ValidationError(
            `Audit metadata key ${describeKey(key)} exceeds ${String(MAX_METADATA_KEY_LENGTH)} characters.`,
            { metadata: ["key_too_long"] },
          ),
        );
      }

      const value = input[key];

      if (typeof value !== "string") {
        return Result.err(
          new ValidationError(
            `Audit metadata value for ${describeKey(key)} must be a string; received ${describeType(value)}.`,
            { metadata: ["non_string_value"] },
          ),
        );
      }

      if (value.length > MAX_METADATA_VALUE_LENGTH) {
        return Result.err(
          new ValidationError(
            `Audit metadata value for ${describeKey(key)} exceeds ${String(MAX_METADATA_VALUE_LENGTH)} characters.`,
            { metadata: ["value_too_long"] },
          ),
        );
      }

      values[key] = value;
    }

    return Result.ok(new AuditMetadata(values));
  }

  /**
   * Wraps metadata that has already been validated, or that came back from
   * trusted storage.
   *
   * The counterpart to {@link create} that `AuditEvent.reconstitute` has for the
   * same reason: re-validating a row that was validated on the way in would
   * mean a rule change silently makes historical records unreadable, and
   * verification would fail on tampering it imagined.
   */
  static of(values: Readonly<Record<string, string>>): AuditMetadata {
    return new AuditMetadata(values);
  }

  /** The empty bag. */
  static empty(): AuditMetadata {
    return new AuditMetadata({});
  }

  /**
   * The bag recorded in place of metadata that failed {@link create}.
   *
   * Recording the reason rather than nothing keeps the fact that somebody tried
   * to attach unusable metadata — which is itself the interesting event — and
   * the replacement is still a valid bag, so nothing downstream has to
   * special-case it.
   */
  static rejected(reason: AuditMetadataRejectionReason): AuditMetadata {
    return new AuditMetadata({ [METADATA_REJECTED_KEY]: reason });
  }

  /** The values as recorded, unmodified. */
  get values(): Readonly<Record<string, string>> {
    return this.#values;
  }

  /**
   * Hash pre-image for this bag: a field count, then each pair as `byteLength:key=byteLength:value`
   * with sorted keys. Length prefixes stop any character inside a key or value from moving a
   * boundary. Lengths are UTF-8 bytes so the digest can be re-derived outside this code.
   */
  get canonicalForm(): string {
    const keys = Object.keys(this.#values).sort();
    const segments: string[] = [String(keys.length)];

    for (const key of keys) {
      const value = this.#values[key] ?? "";
      segments.push(`${utf8ByteLength(key)}:${key}=${utf8ByteLength(value)}:${value}`);
    }

    return segments.join(";");
  }

  /**
   * The bag rendered for textual sinks: control characters, including `\n`, `\r` and `\t`, become
   * visible escapes so a value cannot start or end a record. Structured outputs use {@link values}
   * directly, since their encoders escape what they encode.
   */
  toLogFields(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      Object.entries(this.#values).map(([key, value]) => [
        escapeForText(key),
        escapeForText(value),
      ]),
    );
  }

  /** JSON as it is stored and as JSON-lines export emits it. */
  toJSON(): Readonly<Record<string, string>> {
    return this.#values;
  }
}

const BYTE_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length, which is what a length prefix in a hash pre-image has to
 * mean. Character counts differ between languages — a JavaScript `.length` is
 * UTF-16 code units, so an emoji counts twice here and once elsewhere, and a
 * pre-image that only reproduces in one runtime is not an auditable one.
 */
export function utf8ByteLength(value: string): number {
  return BYTE_ENCODER.encode(value).length;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * A rejected key's name for an error message, truncated and escaped first so a key containing a
 * newline cannot start a new log line. Truncation is by code point so it never leaves a lone
 * surrogate.
 */
function describeKey(key: string): string {
  const codePoints = Array.from(key);
  const preview = codePoints.length > 24 ? `${codePoints.slice(0, 24).join("")}…` : key;
  return `"${escapeForText(preview)}"`;
}

/**
 * Escapes characters that a textual sink would read as structure.
 *
 * One pass, and backslash is one of the things it escapes: a literal `\n` in
 * someone's input would otherwise come out looking exactly like an escaped
 * newline, and the transformation would stop being one-to-one. That it is
 * one-to-one matters — a reader of the log is entitled to reconstruct what was
 * actually supplied.
 */
// eslint-disable-next-line no-control-regex -- the control ranges are the whole point: this is precisely the set of characters a line-oriented or comma-separated sink reads as structure.
const TEXT_UNSAFE = /[\\\u0000-\u001f\u007f-\u009f]/gu;

export function escapeForText(value: string): string {
  return value.replace(TEXT_UNSAFE, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default: {
        const code = character.codePointAt(0) ?? 0;
        return `\\u${code.toString(16).padStart(4, "0")}`;
      }
    }
  });
}

/**
 * Line terminators `JSON.stringify` leaves raw: NEL (U+0085), U+2028 and U+2029. Python's
 * `str.splitlines` treats them as line breaks, so they are written as `\u00nn` escapes, which JSON
 * parsers decode back to the original character.
 */
const RAW_LINE_TERMINATORS = /[\u0085\u2028\u2029]/gu;

export function escapeJsonLineTerminators(value: string): string {
  return value.replace(RAW_LINE_TERMINATORS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/**
 * Neutralizes a value destined for a spreadsheet cell.
 *
 * Quoting alone does not help: Excel evaluates a *quoted* cell that begins with
 * `=` when it is opened from CSV, so the defense has to change the content. A
 * leading apostrophe is the conventional marker, and it is what Excel itself
 * writes when it exports a text cell that starts with a formula character.
 */
export function neutralizeFormulaPrefix(value: string): string {
  return /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}
