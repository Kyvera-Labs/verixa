import { ValidationError } from "../domain/errors.js";
import { Result } from "../domain/result.js";

/**
 * Collects field errors from several independent checks into one `ValidationError` instead of
 * stopping at the first failure (see docs/guides/error-handling.md).
 *
 * ```ts
 * const errors = new ValidationErrorAggregator();
 * const email = errors.collect(Email.create(command.email));
 * const displayName = errors.collect(DisplayName.create(command.displayName));
 *
 * if (errors.hasErrors()) {
 *   return errors.toResult();
 * }
 * // email and displayName are narrowed to their value objects here
 * ```
 */
export class ValidationErrorAggregator {
  // A Map, not a plain object, so merging a field name into it is never a
  // dynamic-property-access "object injection sink" — the field name never
  // touches bracket-index assignment on an object, however it's chosen.
  private readonly fieldErrors = new Map<string, string[]>();

  /**
   * Runs one field's `Result`: on success, returns the value; on failure,
   * merges that field's errors into the aggregate and returns `undefined`.
   * Call this for every field being validated, then check {@link hasErrors}
   * once at the end rather than returning after the first failure.
   */
  collect<T>(result: Result<T, ValidationError>): T | undefined {
    if (Result.isErr(result)) {
      this.merge(result.error.fieldErrors);
      return undefined;
    }
    return result.value;
  }

  /** Merges an already-known field-error map in directly, e.g. from a manual check that isn't itself a `Result`. */
  merge(fieldErrors: Readonly<Record<string, readonly string[]>>): void {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const existing = this.fieldErrors.get(field) ?? [];
      this.fieldErrors.set(field, [...existing, ...messages]);
    }
  }

  hasErrors(): boolean {
    return this.fieldErrors.size > 0;
  }

  /** Builds the aggregated `ValidationError`. Only meaningful after {@link hasErrors} is `true`. */
  toError(message = "Validation failed."): ValidationError {
    return new ValidationError(message, Object.fromEntries(this.fieldErrors));
  }

  /** Convenience: `Result.err(this.toError())` if any errors were collected, otherwise `Result.ok(value)`. */
  toResult<T>(value: T, message?: string): Result<T, ValidationError> {
    return this.hasErrors() ? Result.err(this.toError(message)) : Result.ok(value);
  }
}
