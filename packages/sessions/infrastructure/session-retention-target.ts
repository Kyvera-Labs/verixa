import type { SessionRetentionStore } from "../application/ports/session-retention-store.js";

type SessionRetentionAction = "delete" | "anonymize";

/**
 * Resolves the users who belong to an organization. Sessions are keyed by user,
 * not organization, so retention scoped to an organization has to go through
 * its members. Supplied by the composition root from the identity context.
 */
export type OrganizationUserLookup = (organizationId: string) => Promise<readonly string[]>;

/**
 * Session retention for governance's retention enforcement. Implements `RetentionTarget`
 * structurally, without importing governance. Supports `delete` and `anonymize`; `archive` is
 * refused because archived session state has no use.
 */
export class SessionRetentionTarget {
  readonly resourceType = "sessions" as const;
  readonly supportedActions: readonly SessionRetentionAction[] = ["delete", "anonymize"];

  constructor(
    private readonly store: SessionRetentionStore,
    private readonly usersOfOrganization: OrganizationUserLookup,
  ) {}

  async findExpired(query: {
    readonly organizationId: string;
    readonly action: string;
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly { readonly resourceId: string }[]> {
    const action = this.requireSupported(query.action);
    const userIds = await this.usersOfOrganization(query.organizationId);
    if (userIds.length === 0) return [];

    const ended = await this.store.findEndedBefore({
      userIds,
      endedBefore: query.cutoff,
      action,
      limit: query.limit,
    });
    return ended.map((s) => ({ resourceId: s.id }));
  }

  async apply(
    organizationId: string,
    resourceId: string,
    action: string,
  ): Promise<"applied" | "already_applied"> {
    const supported = this.requireSupported(action);
    const owner = await this.store.ownerOf(resourceId);
    if (owner === undefined) return "already_applied";
    // Scoped: never act on a session of someone outside the organization.
    const members = await this.usersOfOrganization(organizationId);
    if (!members.includes(owner)) {
      throw new Error("Session does not belong to the organization being enforced.");
    }
    const changed =
      supported === "delete"
        ? await this.store.deleteById(resourceId)
        : await this.store.anonymizeById(resourceId);
    return changed ? "applied" : "already_applied";
  }

  private requireSupported(action: string): SessionRetentionAction {
    const supported = this.supportedActions.find((a) => a === action);
    if (supported === undefined) {
      throw new Error(`Session retention does not support the "${action}" action.`);
    }
    return supported;
  }
}
