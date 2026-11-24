import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import { Organization } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import type { UnitOfWork } from "../ports/unit-of-work.js";

export interface CreateOrganizationCommand {
  readonly name: string;
  readonly slug: string;
  readonly ownerId: UserId;
}

export interface CreateOrganizationResult {
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
}

export type CreateOrganizationError = ValidationError | ConflictError;

/**
 * Creates a new `Organization` together with the owner's initial
 * `OrganizationMembership` — the first example in this codebase of a use
 * case spanning **two aggregates in one transaction**. See
 * `docs/guides/use-cases.md` for why that's the use case's job, not either
 * aggregate's: an aggregate only enforces its own invariants, but "an org
 * always has its owner as a member" is a rule that spans both, so it lives
 * at the orchestration layer instead.
 *
 * Both writes run inside a {@link UnitOfWork}, so they commit together or
 * not at all (Issue 048). The use case never learns *how* that atomicity is
 * achieved — against Postgres it's a real transaction, against the in-memory
 * fake it's nothing at all — which is what keeps the application layer free
 * of persistence concepts.
 */
export class CreateOrganization {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    command: CreateOrganizationCommand,
  ): Promise<Result<CreateOrganizationResult, CreateOrganizationError>> {
    return this.unitOfWork.run(async (repositories) => {
      const normalizedSlug = command.slug.trim().toLowerCase();

      // Checked before constructing anything — a duplicate slug is a normal,
      // expected outcome (someone picking an already-taken team URL), not a
      // reason to have touched the store.
      const slugTaken = await repositories.organizations.existsBySlug(normalizedSlug);
      if (slugTaken) {
        return Result.err(
          new ConflictError(`An organization with slug "${normalizedSlug}" already exists.`),
        );
      }

      const organizationResult = Organization.create({
        name: command.name,
        slug: command.slug,
        ownerId: command.ownerId,
      });
      if (Result.isErr(organizationResult)) {
        return organizationResult;
      }

      const membershipResult = OrganizationMembership.create({
        userId: command.ownerId,
        organizationId: organizationResult.value.id,
      });
      if (Result.isErr(membershipResult)) {
        return membershipResult;
      }

      await repositories.organizations.save(organizationResult.value);
      await repositories.memberships.save(membershipResult.value);

      return Result.ok({
        organization: organizationResult.value,
        membership: membershipResult.value,
      });
    });
  }
}
