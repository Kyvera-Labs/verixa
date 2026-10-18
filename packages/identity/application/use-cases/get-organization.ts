import { Result } from "@verixa/shared-kernel";

import type { Organization, OrganizationId } from "../../domain/entities/organization.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

export interface GetOrganizationCommand {
  readonly id?: OrganizationId;
  readonly slug?: string;
}

/**
 * Retrieves a single `Organization` by its ID or slug.
 *
 * Missing organization returns `Result.ok(undefined)`.
 */
export class GetOrganization {
  constructor(private readonly organizationRepository: OrganizationRepository) {}

  async execute(command: GetOrganizationCommand): Promise<Result<Organization | undefined, never>> {
    if (command.id !== undefined) {
      const org = await this.organizationRepository.findById(command.id);
      return Result.ok(org);
    }
    if (command.slug !== undefined) {
      const org = await this.organizationRepository.findBySlug(command.slug);
      return Result.ok(org);
    }
    return Result.ok(undefined);
  }
}
