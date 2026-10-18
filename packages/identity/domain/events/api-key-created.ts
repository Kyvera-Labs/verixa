import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { ApiKeyId } from "../entities/api-key.js";
import type { OrganizationId } from "../entities/organization.js";

/**
 * Domain event emitted when a new API key is created.
 */
export class ApiKeyCreated extends BaseDomainEvent {
  readonly eventName = "identity.api_key.created";
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly keyPreview: string;
  readonly scopes: readonly string[];

  constructor(
    apiKeyId: ApiKeyId,
    organizationId: OrganizationId,
    name: string,
    keyPreview: string,
    scopes: readonly string[],
  ) {
    super(apiKeyId);
    this.organizationId = organizationId;
    this.name = name;
    this.keyPreview = keyPreview;
    this.scopes = scopes;
  }
}
