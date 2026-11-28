import { Result, ValidationError } from "@verixa/shared-kernel";

/**
 * Rules a password must satisfy. Configurable because deployments differ, but
 * the defaults follow NIST SP 800-63B rather than folklore.
 */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
}

/**
 * Password policy following NIST SP 800-63B: length over composition rules, a breach check, and no
 * forced rotation (rotate on evidence of compromise). `minLength` is 12, above the 800-63B minimum
 * of 8.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  /**
   * Upper bound to stop expensive hashing of huge inputs, well above the 64 characters 800-63B
   * requires. Longer passwords are rejected, never silently truncated.
   */
  maxLength: 256,
};

/**
 * Checks a password against known breaches. Intended to use the k-anonymity range API (send the
 * first 5 SHA-1 hex characters, compare suffixes locally) so the password never leaves the server.
 */
export interface BreachedPasswordChecker {
  isBreached(plaintext: string): Promise<boolean>;
}

const REDACTED = "[REDACTED]";

/**
 * A plaintext password that passed policy validation. Functions taking `RawPassword` cannot receive
 * an unvalidated string, and `toString`, `toJSON` and Node's inspect hook return `[REDACTED]` so it
 * cannot leak through logs or error payloads. Use {@link reveal} to read the plaintext.
 */
export class RawPassword {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static create(
    plaintext: string,
    policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  ): Result<RawPassword, ValidationError> {
    // Deliberately not trimmed. Leading and trailing spaces are legitimate
    // password characters, and silently stripping them would mean a password
    // that cannot be typed back in — the user would be locked out by a
    // convenience nobody asked for.
    if (plaintext.length < policy.minLength) {
      return Result.err(
        new ValidationError(`Password must be at least ${String(policy.minLength)} characters.`, {
          password: ["too_short"],
        }),
      );
    }

    if (plaintext.length > policy.maxLength) {
      return Result.err(
        new ValidationError(`Password must be at most ${String(policy.maxLength)} characters.`, {
          password: ["too_long"],
        }),
      );
    }

    return Result.ok(new RawPassword(plaintext));
  }

  /**
   * The plaintext. Named to stand out: every call site is somewhere a secret
   * escapes this wrapper, and should be reviewed as such. Legitimately called
   * in exactly one place — passing the password to the hasher.
   */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /**
   * Node's `util.inspect` hook, which is what `console.log` actually uses for
   * objects. Without it, `toString` would be bypassed and the field printed
   * in full — the exact accident this class exists to prevent.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
