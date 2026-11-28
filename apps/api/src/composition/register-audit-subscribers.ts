import {
  type PermissionGrantedEvent,
  PermissionGrantedAuditSubscriber,
  type RecordAuditEvent,
  type RoleAssignedEvent,
  RoleAssignedAuditSubscriber,
  type SessionCreatedEvent,
  SessionCreatedAuditSubscriber,
  type SessionRevokedEvent,
  SessionRevokedAuditSubscriber,
} from "@verixa/audit";
import type { DomainEventPublisher } from "@verixa/shared-kernel";

/**
 * Registers every audit subscriber on the event publisher at startup. Events published with no
 * subscriber are dropped permanently, so subscribers must exist before any publisher runs; lazy
 * registration would lose the first event without trace.
 *
 * This function is the complete registry. `tests/integration/audit-subscriber-registration.spec.ts`
 * checks one event per subscriber, so a subscriber missing here fails a test. Some subscribers have
 * no publisher yet, which is harmless.
 */
export function registerAuditSubscribers(
  publisher: DomainEventPublisher,
  recordEvent: RecordAuditEvent,
): void {
  const sessionCreated = new SessionCreatedAuditSubscriber(recordEvent);
  const sessionRevoked = new SessionRevokedAuditSubscriber(recordEvent);
  const roleAssigned = new RoleAssignedAuditSubscriber(recordEvent);
  const permissionGranted = new PermissionGrantedAuditSubscriber(recordEvent);

  publisher.subscribe<SessionCreatedEvent>("sessions.session.created", (event) =>
    sessionCreated.handle(event),
  );
  publisher.subscribe<SessionRevokedEvent>("sessions.session.revoked", (event) =>
    sessionRevoked.handle(event),
  );
  publisher.subscribe<RoleAssignedEvent>("rbac.role.assigned", (event) =>
    roleAssigned.handle(event),
  );
  publisher.subscribe<PermissionGrantedEvent>("rbac.permission.granted", (event) =>
    permissionGranted.handle(event),
  );
}
