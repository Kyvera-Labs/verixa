import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

import type { Organization, OrganizationId } from "../../domain/entities/organization.js";
import type { OrganizationRepository } from "../ports/organization-repository.js";

export interface UpdateOrganizationCommand {
  readonly id: OrganizationId;
  readonly name?: string;
  readonly slug?: string;
}

export type UpdateOrganizationError = ValidationError | ConflictError;

export class UpdateOrganization {
  constructor(private readonly organizationRepository: OrganizationRepository) {}

  async execute(
    command: UpdateOrganizationCommand,
  ): Promise<Result<Organization | undefined, UpdateOrganizationError>> {
    const organization = await this.organizationRepository.findById(command.id);
    if (organization === undefined || organization.status === "deleted") {
      return Result.ok(undefined);
    }

    const normalizedSlug = command.slug?.trim().toLowerCase();
    if (
      normalizedSlug !== undefined &&
      normalizedSlug !== organization.slug &&
      (await this.organizationRepository.existsBySlug(normalizedSlug))
    ) {
      return Result.err(
        new ConflictError(`An organization with slug "${normalizedSlug}" already exists.`),
      );
    }

    const updated = organization.update({
      ...(command.name === undefined ? {} : { name: command.name }),
      ...(normalizedSlug === undefined ? {} : { slug: normalizedSlug }),
    });
    if (Result.isErr(updated)) {
      return updated;
    }

    await this.organizationRepository.save(updated.value);
    return Result.ok(updated.value);
  }
}
