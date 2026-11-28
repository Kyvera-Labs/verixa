import { createId, type Id } from "@verixa/shared-kernel";

import type { AuditAction } from "../value-objects/audit-action.js";
import { isAuditAction } from "../value-objects/audit-action.js";
import { validateAuditMetadata } from "../value-objects/audit-metadata-schemas.js";

export type AuditEventId = Id<"AuditEventId">;

/**
 * Resource type identifier.
 *
 * Describes what kind of entity the audit event pertains to. Combined with
 * `resourceId`, this forms a complete reference to the affected resource.
 *
 * Examples: `user`, `organization`, `session`, `verification_request`, `role`
 */
export type ResourceType = string;

/**
 * Organization identifier. Every audit event is scoped to one organization; system-level events may
 * use a well-known sentinel ID.
 */
export type OrganizationId = string;

interface AuditEventProps {
  readonly id: AuditEventId;
  readonly actorId: string | undefined;
  readonly action: AuditAction;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly timestamp: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly organizationId: OrganizationId;
}

/**
 * An immutable record of a security-relevant action. There are no setters, the repository has no
 * update or delete, and the database revokes UPDATE/DELETE; corrections are new events.
 *
 * `actorId` is undefined for system actions with no initiating actor. Action-specific details live
 * in `metadata`, validated per action (see `audit-metadata-schemas.ts`). Every event carries
 * `organizationId` for tenant isolation.
 */
export class AuditEvent {
  readonly id: AuditEventId;
  readonly actorId: string | undefined;
  readonly action: AuditAction;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly timestamp: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly organizationId: OrganizationId;

  private constructor(props: AuditEventProps) {
    this.id = props.id;
    this.actorId = props.actorId;
    this.action = props.action;
    this.resourceType = props.resourceType;
    this.resourceId = props.resourceId;
    this.timestamp = props.timestamp;
    this.metadata = Object.freeze({ ...props.metadata });
    this.organizationId = props.organizationId;
  }

  /**
   * Creates a new audit event with validation.
   *
   * @param params - Event parameters
   * @param params.actorId - The actor who initiated the action, or undefined for system actions
   * @param params.action - The action that occurred (must be a valid AuditAction)
   * @param params.resourceType - The type of resource affected
   * @param params.resourceId - The ID of the affected resource
   * @param params.organizationId - The organization this event belongs to
   * @param params.metadata - Action-specific metadata (validated against the action's schema)
   * @param params.timestamp - When the event occurred (defaults to now)
   * @throws {Error} If the action is not a valid AuditAction
   * @throws {ZodError} If metadata validation fails for the action's schema
   */
  static create(params: {
    actorId?: string | undefined;
    action: string;
    resourceType: ResourceType;
    resourceId: string;
    organizationId: OrganizationId;
    metadata?: Record<string, unknown>;
    timestamp?: Date;
  }): AuditEvent {
    if (!isAuditAction(params.action)) {
      throw new Error(
        `Invalid audit action: "${params.action}". Action must be registered in AuditAction type.`,
      );
    }

    const validatedMetadata = validateAuditMetadata(params.action, params.metadata ?? {});

    return new AuditEvent({
      id: createId<"AuditEventId">(),
      actorId: params.actorId,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      timestamp: params.timestamp ?? new Date(),
      metadata: validatedMetadata,
      organizationId: params.organizationId,
    });
  }

  /**
   * Reconstitutes an audit event from storage without validation. Never use it with untrusted
   * input; use `create()` instead.
   */
  static reconstitute(props: AuditEventProps): AuditEvent {
    return new AuditEvent(props);
  }

  /**
   * Returns a copy with different metadata, bypassing validation. For tests and data migrations
   * only, never production code.
   */
  withMetadata(metadata: Record<string, unknown>): AuditEvent {
    return new AuditEvent({
      id: this.id,
      actorId: this.actorId,
      action: this.action,
      resourceType: this.resourceType,
      resourceId: this.resourceId,
      timestamp: this.timestamp,
      metadata: Object.freeze({ ...metadata }),
      organizationId: this.organizationId,
    });
  }
}
