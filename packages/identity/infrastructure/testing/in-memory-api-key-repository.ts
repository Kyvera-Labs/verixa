import type { ApiKey, ApiKeyId } from "../../domain/entities/api-key.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { ApiKeyRepository } from "../../application/ports/api-key-repository.js";

/**
 * In-memory ApiKeyRepository for testing without a database.
 */
export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private readonly keys = new Map<string, ApiKey>();

  findById(id: ApiKeyId): Promise<ApiKey | undefined> {
    return Promise.resolve(this.keys.get(id));
  }

  findByKeyHash(keyHash: string): Promise<ApiKey | undefined> {
    for (const key of this.keys.values()) {
      if (key.keyHash === keyHash) {
        return Promise.resolve(key);
      }
    }
    return Promise.resolve(undefined);
  }

  findByOrganizationId(organizationId: OrganizationId): Promise<readonly ApiKey[]> {
    const list: ApiKey[] = [];
    for (const key of this.keys.values()) {
      if (key.organizationId === organizationId) {
        list.push(key);
      }
    }
    return Promise.resolve(list);
  }

  save(apiKey: ApiKey): Promise<void> {
    this.keys.set(apiKey.id, apiKey);
    return Promise.resolve();
  }
}
