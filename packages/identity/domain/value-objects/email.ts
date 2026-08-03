import { Result, ValidationError } from "@verixa/shared-kernel";

const MAX_LENGTH = 254; // RFC 5321 §4.5.3.1.3 total-path length limit

// Deliberately not a full RFC 5322 grammar (that grammar permits addresses
// like `"very unusual"@example.com` that no real-world signup form should
// accept) — this is the pragmatic "local@domain, domain has a dot" shape
// used by most production systems, tightened just enough to reject obvious
// garbage while staying permissive about the local part.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * An immutable, validated, normalized email address. Constructing one is the
 * only way an email string enters the domain layer — every other layer
 * (application, interface) works with `Email`, never a raw `string`, so
 * "is this a valid email" is answered once, at the boundary, not re-checked
 * (or forgotten) at every call site.
 */
export class Email {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /**
   * Normalizes (trims, lowercases) and validates a raw email string.
   * Lowercasing matters for {@link equals}: `Alice@Example.com` and
   * `alice@example.com` should be treated as the same address, since email
   * domains are case-insensitive in practice and most providers treat the
   * local part case-insensitively too.
   */
  static create(raw: string): Result<Email, ValidationError> {
    const normalized = raw.trim().toLowerCase();

    if (normalized.length === 0) {
      return Result.err(new ValidationError("Email is required.", { email: ["required"] }));
    }

    if (normalized.length > MAX_LENGTH) {
      return Result.err(
        new ValidationError(`Email must be at most ${MAX_LENGTH} characters.`, {
          email: ["too_long"],
        }),
      );
    }

    if (!EMAIL_PATTERN.test(normalized)) {
      return Result.err(
        new ValidationError("Email is not a valid address.", { email: ["invalid_format"] }),
      );
    }

    return Result.ok(new Email(normalized));
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
