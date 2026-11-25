import type {
  RetentionAction,
  RetentionResourceType,
  RetentionRule,
} from "../../domain/retention-rule.js";

/** Where the job learns which rules are in force. */
export interface RetentionRuleSource {
  /** Every rule currently in force, across organizations. Inactive rules are omitted. */
  listActiveRules(): Promise<readonly RetentionRule[]>;
}

export type RetentionOutcome = "applied" | "already_applied" | "refused" | "failed";

/** One enforcement action, as recorded. The record of what the job did. */
export interface RetentionActionRecord {
  readonly ruleId: string;
  readonly organizationId: string;
  readonly resourceType: RetentionResourceType;
  /** The affected record, or `*` for a refusal that concerns the rule itself. */
  readonly resourceId: string;
  readonly action: RetentionAction;
  readonly outcome: RetentionOutcome;
  readonly occurredAt: Date;
  readonly detail?: string;
}

/**
 * Append-only log of enforcement actions.
 *
 * `append` never removes or edits. `wasCompleted` answers whether a rule's
 * action on a resource already finished, so the job can skip it; `applied` and
 * `already_applied` count as finished, `refused` and `failed` do not.
 */
export interface RetentionActionLog {
  append(record: RetentionActionRecord): Promise<void>;
  wasCompleted(ruleId: string, resourceId: string, action: RetentionAction): Promise<boolean>;
}
