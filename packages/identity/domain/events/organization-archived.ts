import { BaseDomainEvent } from "@verixa/shared-kernel";
import type { OrganizationId } from "../entities/organization.js";
export class OrganizationArchived extends BaseDomainEvent {
  readonly eventName = "identity.organization.archived";
  constructor(id: OrganizationId) { super(id); }
}
