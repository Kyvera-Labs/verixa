import type { VerificationRetentionStore } from "../application/ports/verification-retention-store.js";

type VerificationRetentionAction = "delete" | "archive";

/**
 * Verification retention for governance's retention enforcement. Implements `RetentionTarget`
 * structurally, without importing governance. Supports `delete` and `archive`; `anonymize` is
 * refused because a verification record means nothing without its subject.
 */
export class VerificationRetentionTarget {
  readonly resourceType = "verification" as const;
  readonly supportedActions: readonly VerificationRetentionAction[] = ["delete", "archive"];

  constructor(private readonly store: VerificationRetentionStore) {}

  async findExpired(query: {
    readonly organizationId: string;
    readonly action: string;
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly { readonly resourceId: string }[]> {
    const action = this.requireSupported(query.action);
    const found = await this.store.findDecidedBefore({
      organizationId: query.organizationId,
      decidedBefore: query.cutoff,
      action,
      limit: query.limit,
    });
    return found.map((r) => ({ resourceId: r.id }));
  }

  async apply(
    organizationId: string,
    resourceId: string,
    action: string,
  ): Promise<"applied" | "already_applied"> {
    const supported = this.requireSupported(action);
    const changed =
      supported === "delete"
        ? await this.store.deleteById(organizationId, resourceId)
        : await this.store.archiveById(organizationId, resourceId);
    return changed ? "applied" : "already_applied";
  }

  private requireSupported(action: string): VerificationRetentionAction {
    const supported = this.supportedActions.find((a) => a === action);
    if (supported === undefined) {
      throw new Error(`Verification retention does not support the "${action}" action.`);
    }
    return supported;
  }
}
