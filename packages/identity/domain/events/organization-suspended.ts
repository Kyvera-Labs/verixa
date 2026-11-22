import { BaseDomainEvent } from "@verixa/shared-kernel";
import type { OrganizationId } from "../entities/organization.js";
export class OrganizationSuspended extends BaseDomainEvent {
  readonly eventName = "identity.organization.suspended";
  constructor(id: OrganizationId) { super(id); }
}
