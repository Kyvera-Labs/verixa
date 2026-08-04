import type { Organization, OrganizationId } from "../../domain/entities/organization.js";

/**
 * The persistence contract for `Organization`. See `user-repository.ts` for
 * the general port/adapter contract conventions this mirrors.
 *
 * - `findById`/`findBySlug` return `undefined` when nothing matches.
 * - `save` is an idempotent upsert.
 * - `existsBySlug` is a cheap existence check backing slug-uniqueness
 *   validation, same rationale as `UserRepository.existsByEmail`.
 */
export interface OrganizationRepository {
  findById(id: OrganizationId): Promise<Organization | undefined>;
  findBySlug(slug: string): Promise<Organization | undefined>;
  save(organization: Organization): Promise<void>;
  existsBySlug(slug: string): Promise<boolean>;
}
