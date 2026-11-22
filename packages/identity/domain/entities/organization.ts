import { createId, type DomainEvent, type Id, Result, ValidationError } from "@verixa/shared-kernel";
import { OrganizationArchived } from "../events/organization-archived.js";
import { OrganizationCreated } from "../events/organization-created.js";
import { OrganizationSuspended } from "../events/organization-suspended.js";

import type { UserId } from "./user.js";

export type OrganizationId = Id<"OrganizationId">;

export type OrganizationStatus = "active" | "suspended" | "archived" | "deleted";

const MAX_NAME_LENGTH = 128;

const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 63;
const SLUG_SEGMENT_PATTERN = /^[a-z0-9]+$/u;

// Slugs are URL-safe unique keys (used in routes/subdomains), so they're
// restricted to lowercase alphanumerics and single internal hyphens — no
// leading/trailing/doubled hyphens, no uppercase, no unicode. Unlike
// DisplayName/PersonName, this restriction is deliberate: a slug is an
// identifier, not a display string, so internationalization concerns don't
// apply the same way. Validated by splitting on hyphens and checking each
// segment individually (rather than one `(segment-)*` regex) so the pattern
// has no nested quantifier for a linter or a malicious input to worry about.
function isValidSlug(slug: string): boolean {
  const segments = slug.split("-");
  return segments.every((segment) => SLUG_SEGMENT_PATTERN.test(segment));
}

interface OrganizationProps {
  readonly id: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: UserId;
  readonly status: OrganizationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * The multi-tenancy aggregate root: a team/company using Verixa-protected
 * apps. Every organization has exactly one owner at creation (ownership
 * transfer is a separate, explicit operation for a later phase, not
 * something this constructor supports) — see
 * `docs/guides/domain-modeling.md` for the multi-tenancy modeling notes.
 */
export class Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: UserId;
  readonly status: OrganizationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: OrganizationProps) {
    this.id = props.id;
    this.name = props.name;
    this.slug = props.slug;
    this.ownerId = props.ownerId;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  static create(params: {
    name: string;
    slug: string;
    ownerId: UserId;
  }): Result<Organization, ValidationError> {
    const normalizedName = params.name.trim();
    const normalizedSlug = params.slug.trim().toLowerCase();

    const fieldErrors: Record<string, string[]> = {};

    if (normalizedName.length === 0) {
      fieldErrors["name"] = ["required"];
    } else if (normalizedName.length > MAX_NAME_LENGTH) {
      fieldErrors["name"] = ["too_long"];
    }

    if (normalizedSlug.length < MIN_SLUG_LENGTH) {
      fieldErrors["slug"] = ["too_short"];
    } else if (normalizedSlug.length > MAX_SLUG_LENGTH) {
      fieldErrors["slug"] = ["too_long"];
    } else if (!isValidSlug(normalizedSlug)) {
      fieldErrors["slug"] = ["invalid_format"];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Organization is invalid.", fieldErrors));
    }

    const now = new Date();
    const id = createId<"OrganizationId">();
    return Result.ok(
      new Organization({
        id,
        name: normalizedName,
        slug: normalizedSlug,
        ownerId: params.ownerId,
        status: "active",
        createdAt: now,
        updatedAt: now,
        domainEvents: [new OrganizationCreated(id)],
      }),
    );
  }

  /** Rebuilds an `Organization` from already-trusted data (e.g. a database row). */
  static reconstitute(props: OrganizationProps): Organization {
    return new Organization({ ...props, domainEvents: [] });
  }

  private transitionTo(next: OrganizationStatus, event: DomainEvent): Result<Organization, ValidationError> {
    const allowed: Readonly<Record<OrganizationStatus, readonly OrganizationStatus[]>> = {
      active: ["suspended", "archived"], suspended: ["active", "archived"], archived: [], deleted: [],
    };
    if (!allowed[this.status].includes(next)) {
      return Result.err(new ValidationError(`Cannot transition organization from "${this.status}" to "${next}".`, {
        status: [`invalid_transition_from_${this.status}`],
      }));
    }
    return Result.ok(new Organization({ ...this, status: next, updatedAt: new Date(), domainEvents: [event] }));
  }

  suspend(): Result<Organization, ValidationError> {
    return this.transitionTo("suspended", new OrganizationSuspended(this.id));
  }

  activate(): Result<Organization, ValidationError> {
    return this.transitionTo("active", new OrganizationCreated(this.id));
  }

  archive(): Result<Organization, ValidationError> {
    return this.transitionTo("archived", new OrganizationArchived(this.id));
  }

  pullDomainEvents(): readonly DomainEvent[] { return this.domainEvents; }
}
