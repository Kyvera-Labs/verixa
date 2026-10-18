import type { ApiKey, ApiKeyId } from "../../domain/entities/api-key.js";
import type { OrganizationId } from "../../domain/entities/organization.js";

/**
 * Port for persisting and querying ApiKey entities.
 */
export interface ApiKeyRepository {
  findById(id: ApiKeyId): Promise<ApiKey | undefined>;
  findByKeyHash(keyHash: string): Promise<ApiKey | undefined>;
  findByOrganizationId(organizationId: OrganizationId): Promise<readonly ApiKey[]>;
  save(apiKey: ApiKey): Promise<void>;
}
