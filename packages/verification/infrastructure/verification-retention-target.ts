import type { VerificationRetentionStore } from "../application/ports/verification-retention-store.js";

type VerificationRetentionAction = "delete" | "archive";

/**
 * Verification retention for governance's retention enforcement.
 *
 * Implements governance's `RetentionTarget` contract structurally, with no
 * import of it, so this context does not depend on governance. The composition
 * root joins the two and the compiler checks the fit there.
 *
 * Supports `delete` and `archive`. `anonymize` is refused: a verification
 * request is meaningful only in connection with the person it verifies, and
 * stripping that link would leave a record that proves nothing.
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
