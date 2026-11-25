import {
  AuditEvent,
  type AuditEventId,
  type OrganizationId,
  type ResourceType,
} from "@verixa/audit";
import { createId } from "@verixa/shared-kernel";

export interface AuditEventFactoryOptions {
  id?: AuditEventId | string;
  actorId?: string;
  action?: string;
  resourceType?: ResourceType;
  resourceId?: string;
  organizationId?: OrganizationId;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

/**
 * Creates a domain-valid `AuditEvent` entity with sensible defaults and optional overrides.
 */
export function makeAuditEvent(overrides: AuditEventFactoryOptions = {}): AuditEvent {
  const organizationId = overrides.organizationId ?? createId<"OrganizationId">();

  const action = overrides.action ?? "identity.user.registered";
  const resourceType = overrides.resourceType ?? "user";
  const resourceId = overrides.resourceId ?? "res-123";

  return AuditEvent.create({
    actorId: overrides.actorId,
    action,
    resourceType,
    resourceId,
    organizationId,
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? new Date(),
  });
}
