import { BaseDomainEvent } from "@verixa/shared-kernel";
import type { OrganizationId } from "../entities/organization.js";
export class OrganizationCreated extends BaseDomainEvent {
  readonly eventName = "identity.organization.created";
  constructor(id: OrganizationId) { super(id); }
}
