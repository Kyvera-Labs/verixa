import { Result } from "@verixa/shared-kernel";

import type { Organization } from "../../domain/entities/organization.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

/**
 * Lists all organizations that are not soft-deleted.
 */
export class ListOrganizations {
  constructor(private readonly organizationRepository: OrganizationRepository) {}

  async execute(): Promise<Result<Organization[], never>> {
    const orgs = await this.organizationRepository.findAll();
    return Result.ok(orgs);
  }
}
