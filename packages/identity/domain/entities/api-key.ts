import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createId,
  type DomainEvent,
  type Id,
  Result,
  ValidationError,
} from "@verixa/shared-kernel";

import { ApiKeyCreated } from "../events/api-key-created.js";

import type { OrganizationId } from "./organization.js";

export type ApiKeyId = Id<"ApiKeyId">;

export type ApiKeyStatus = "active" | "revoked" | "expired";

export interface IssuedApiKey {
  readonly apiKey: ApiKey;
  readonly rawKey: string;
}

const API_KEY_PREFIX = "vx_";
const KEY_BYTES = 32;

interface ApiKeyProps {
  readonly id: ApiKeyId;
  readonly name: string;
  readonly organizationId: OrganizationId;
  readonly keyHash: string;
  readonly keyPreview: string;
  readonly scopes: readonly string[];
  readonly status: ApiKeyStatus;
  readonly expiresAt?: Date | undefined;
  readonly createdAt: Date;
  readonly revokedAt?: Date | undefined;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * Machine credential representing a service principal scoped to an organization.
 * Stored hashed-at-rest using SHA-256 with constant-time verification.
 */
export class ApiKey {
  readonly id: ApiKeyId;
  readonly name: string;
  readonly organizationId: OrganizationId;
  readonly keyHash: string;
  readonly keyPreview: string;
  readonly scopes: readonly string[];
  readonly status: ApiKeyStatus;
  readonly expiresAt?: Date | undefined;
  readonly createdAt: Date;
  readonly revokedAt?: Date | undefined;
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: ApiKeyProps) {
    this.id = props.id;
    this.name = props.name;
    this.organizationId = props.organizationId;
    this.keyHash = props.keyHash;
    this.keyPreview = props.keyPreview;
    this.scopes = Object.freeze([...props.scopes]);
    this.status = props.status;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
    this.revokedAt = props.revokedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  /**
   * Hashes a raw API key using SHA-256.
   */
  static hashKey(rawKey: string): string {
    return createHash("sha256").update(rawKey, "utf8").digest("hex");
  }

  /**
   * Creates a new API key and returns both the entity (with hashed key) and raw key.
   */
  static create(params: {
    readonly name: string;
    readonly organizationId: OrganizationId;
    readonly scopes?: readonly string[] | undefined;
    readonly expiresAt?: Date | undefined;
  }): Result<IssuedApiKey, ValidationError> {
    const trimmedName = params.name.trim();
    if (trimmedName.length === 0) {
      return Result.err(new ValidationError("API key name must not be empty."));
    }

    if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
      return Result.err(new ValidationError("Expiration date must be in the future."));
    }

    const id = createId<"ApiKeyId">();
    const entropy = randomBytes(KEY_BYTES).toString("base64url");
    const rawKey = `${API_KEY_PREFIX}${entropy}`;
    const keyHash = ApiKey.hashKey(rawKey);
    const keyPreview = rawKey.slice(-4);
    const now = new Date();
    const scopes = params.scopes ?? [];

    const apiKey = new ApiKey({
      id,
      name: trimmedName,
      organizationId: params.organizationId,
      keyHash,
      keyPreview,
      scopes,
      status: "active",
      expiresAt: params.expiresAt,
      createdAt: now,
      revokedAt: undefined,
      domainEvents: [new ApiKeyCreated(id, params.organizationId, trimmedName, keyPreview, scopes)],
    });

    return Result.ok({ apiKey, rawKey });
  }

  static reconstitute(props: ApiKeyProps): ApiKey {
    return new ApiKey(props);
  }

  /**
   * Checks whether this key matches a supplied raw token using constant-time comparison.
   */
  matchesKey(candidateRawKey: string): boolean {
    const candidateHash = ApiKey.hashKey(candidateRawKey);
    const a = Buffer.from(this.keyHash, "hex");
    const b = Buffer.from(candidateHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Checks whether the key is active (not revoked and not expired).
   */
  isActive(now = new Date()): boolean {
    if (this.status !== "active") return false;
    if (this.expiresAt && this.expiresAt.getTime() <= now.getTime()) return false;
    return true;
  }

  /**
   * Revokes the API key.
   */
  revoke(now = new Date()): ApiKey {
    if (this.status === "revoked") return this;
    return new ApiKey({
      id: this.id,
      name: this.name,
      organizationId: this.organizationId,
      keyHash: this.keyHash,
      keyPreview: this.keyPreview,
      scopes: this.scopes,
      status: "revoked",
      expiresAt: this.expiresAt,
      createdAt: this.createdAt,
      revokedAt: now,
      domainEvents: this.domainEvents,
    });
  }

  pullDomainEvents(): readonly DomainEvent[] {
    return this.domainEvents;
  }
}
