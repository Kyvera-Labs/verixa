import { NotFoundError, Result } from "@verixa/shared-kernel";

import type { Organization, OrganizationId } from "../../domain/entities/organization.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

export class ListChildOrganizations {
  constructor(private readonly organizationRepository: OrganizationRepository) {}

  async execute(organizationId: OrganizationId): Promise<Result<Organization[], NotFoundError>> {
    const parent = await this.organizationRepository.findById(organizationId);
    if (parent === undefined) {
      return Result.err(new NotFoundError("Organization was not found."));
    }
    return Result.ok(await this.organizationRepository.findChildren(organizationId));
  }
}
