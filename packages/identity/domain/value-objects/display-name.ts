import { Result, ValidationError } from "@verixa/shared-kernel";

const MIN_LENGTH = 1;
const MAX_LENGTH = 64;

/**
 * The name a user is shown as throughout the product — distinct from
 * {@link PersonName}, which is optional structured legal/given-family data.
 * Every user has a `DisplayName`; not every user provides a `PersonName`.
 */
export class DisplayName {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static create(raw: string): Result<DisplayName, ValidationError> {
    const normalized = raw.trim();

    if (normalized.length < MIN_LENGTH) {
      return Result.err(
        new ValidationError("Display name is required.", { displayName: ["required"] }),
      );
    }

    if (normalized.length > MAX_LENGTH) {
      return Result.err(
        new ValidationError(`Display name must be at most ${MAX_LENGTH} characters.`, {
          displayName: ["too_long"],
        }),
      );
    }

    return Result.ok(new DisplayName(normalized));
  }

  equals(other: DisplayName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
