import {
  Result,
  ValidationError,
  type DomainEventPublisher,
} from "@verixa/shared-kernel";

import { ApiKey, type IssuedApiKey } from "../../domain/entities/api-key.js";
import type { OrganizationId } from "../../domain/entities/organization.js";
import type { ApiKeyRepository } from "../ports/api-key-repository.js";

export interface CreateApiKeyCommand {
  readonly name: string;
  readonly organizationId: OrganizationId;
  readonly scopes?: readonly string[] | undefined;
  readonly expiresAt?: Date | undefined;
}

export type CreateApiKeyResult = IssuedApiKey;

export type CreateApiKeyError = ValidationError;

/**
 * Use case to create and persist an ApiKey, publishing its creation event to audit subscribers.
 */
export class CreateApiKey {
  constructor(
    private readonly apiKeys: ApiKeyRepository,
    private readonly eventPublisher?: DomainEventPublisher,
  ) {}

  async execute(command: CreateApiKeyCommand): Promise<Result<CreateApiKeyResult, CreateApiKeyError>> {
    const creationResult = ApiKey.create({
      name: command.name,
      organizationId: command.organizationId,
      scopes: command.scopes,
      expiresAt: command.expiresAt,
    });

    if (Result.isErr(creationResult)) {
      return creationResult;
    }

    const issued = creationResult.value;
    await this.apiKeys.save(issued.apiKey);

    if (this.eventPublisher) {
      for (const event of issued.apiKey.pullDomainEvents()) {
        await this.eventPublisher.publish(event);
      }
    }

    return Result.ok(issued);
  }
}
