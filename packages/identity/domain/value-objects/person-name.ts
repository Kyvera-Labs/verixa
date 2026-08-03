import { Result, ValidationError } from "@verixa/shared-kernel";

const MAX_PART_LENGTH = 128;

/**
 * A person's structured legal/given name — entirely optional on a `User`
 * (see {@link DisplayName} for the name shown throughout the product).
 *
 * Deliberately does **not** enforce a Latin charset, a specific casing, or
 * that every person has both a given and a family name: many cultures use a
 * single mononym, list family name first, or don't split names into
 * given/family at all. `familyName` is optional for exactly this reason —
 * requiring it would incorrectly reject real names, not just malformed
 * input. This is intentionally permissive; see
 * `docs/guides/domain-modeling.md` for the internationalization pitfalls
 * this sidesteps.
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
