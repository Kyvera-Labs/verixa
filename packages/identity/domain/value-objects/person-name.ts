import { Result, ValidationError } from "@verixa/shared-kernel";

const MAX_PART_LENGTH = 128;

/**
 * A person's optional structured name (see {@link DisplayName} for the name shown in the product).
 * Deliberately permissive: no character set, casing or given/family requirement, since many names
 * are mononyms or family-name-first. `familyName` is optional for that reason (see
 * docs/guides/domain-modeling.md).
 */
export class PersonName {
  readonly givenName: string;
  readonly familyName: string | undefined;

  private constructor(givenName: string, familyName: string | undefined) {
    this.givenName = givenName;
    this.familyName = familyName;
  }

  static create(givenName: string, familyName?: string): Result<PersonName, ValidationError> {
    const normalizedGiven = givenName.trim();
    const normalizedFamily = familyName?.trim();

    const fieldErrors: Record<string, string[]> = {};

    if (normalizedGiven.length === 0) {
      fieldErrors["givenName"] = ["required"];
    } else if (normalizedGiven.length > MAX_PART_LENGTH) {
      fieldErrors["givenName"] = ["too_long"];
    }

    if (normalizedFamily !== undefined && normalizedFamily.length > MAX_PART_LENGTH) {
      fieldErrors["familyName"] = ["too_long"];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Person name is invalid.", fieldErrors));
    }

    return Result.ok(
      new PersonName(normalizedGiven, normalizedFamily === "" ? undefined : normalizedFamily),
    );
  }

  /** A single display-oriented string, omitting the family name if absent. */
  toFullName(): string {
    return this.familyName === undefined ? this.givenName : `${this.givenName} ${this.familyName}`;
  }

  equals(other: PersonName): boolean {
    return this.givenName === other.givenName && this.familyName === other.familyName;
  }
}
