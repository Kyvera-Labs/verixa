import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

import { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import { Organization } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";
import type { OrganizationMembershipRepository } from "../ports/organization-membership-repository.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

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
 * The two `save` calls below aren't wrapped in a real database transaction
 * yet — there's no database until Phase 03. This use case defines *where*
 * that transaction boundary belongs (both saves succeed or neither does);
 * the Prisma-backed adapters land in Phase 03 make that atomic in practice.
 */
export class CreateOrganization {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
    private readonly membershipRepository: OrganizationMembershipRepository,
  ) {}

  async execute(
    command: CreateOrganizationCommand,
  ): Promise<Result<CreateOrganizationResult, CreateOrganizationError>> {
    const normalizedSlug = command.slug.trim().toLowerCase();

    // Checked before constructing anything — a duplicate slug is a normal,
    // expected outcome (someone picking an already-taken team URL), not a
    // reason to have touched the store.
    const slugTaken = await this.organizationRepository.existsBySlug(normalizedSlug);
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

    await this.organizationRepository.save(organizationResult.value);
    await this.membershipRepository.save(membershipResult.value);

    return Result.ok({
      organization: organizationResult.value,
      membership: membershipResult.value,
    });
  }
}
