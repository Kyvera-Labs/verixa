import type { OrganizationRepository } from "../../application/ports/organization-repository.js";
import type { Organization, OrganizationId } from "../../domain/entities/organization.js";

/** In-memory `OrganizationRepository` — see `in-memory-user-repository.ts` for the rationale. */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly organizationsById = new Map<OrganizationId, Organization>();

  findById(id: OrganizationId): Promise<Organization | undefined> {
    return Promise.resolve(this.organizationsById.get(id));
  }

  findManyByIds(ids: readonly OrganizationId[]): Promise<Organization[]> {
    const idSet = new Set(ids);
    const orgs = [...this.organizationsById.values()].filter((org) => idSet.has(org.id));
    return Promise.resolve(orgs);
  }

  findBySlug(slug: string): Promise<Organization | undefined> {
    return Promise.resolve(
      [...this.organizationsById.values()].find((organization) => organization.slug === slug),
    );
  }

  findAll(): Promise<Organization[]> {
    return Promise.resolve([...this.organizationsById.values()]);
  }

  save(organization: Organization): Promise<void> {
    this.organizationsById.set(organization.id, organization);
    return Promise.resolve();
  }

  existsBySlug(slug: string): Promise<boolean> {
    return Promise.resolve(
      [...this.organizationsById.values()].some((organization) => organization.slug === slug),
    );
  }
}
