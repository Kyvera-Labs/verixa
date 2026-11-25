import { Result, ValidationError, createId, type Id } from "@verixa/shared-kernel";

/**
 * The categories of data a retention rule can govern. A closed list so a typo
 * is rejected when the rule is created, not discovered when enforcement runs.
 */
export const RETENTION_RESOURCE_TYPES = ["sessions", "verification", "audit_export"] as const;
export type RetentionResourceType = (typeof RETENTION_RESOURCE_TYPES)[number];

export const RETENTION_ACTIONS = ["delete", "anonymize", "archive"] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

/**
 * Which actions each resource type may ever be given. This is the structural
 * guard behind "audit records are never deleted": `audit_export` permits
 * archival only, so no rule can request deletion of it, and the enforcement job
 * checks the same table again before touching a target.
 *
 * Alternative rejected: a runtime `if (type === "audit") refuse` inside the job.
 * A table is one place to review and cannot be bypassed by adding a new code
 * path that forgets the check.
 */
export const PERMITTED_RETENTION_ACTIONS: Readonly<
  Record<RetentionResourceType, readonly RetentionAction[]>
> = {
  sessions: ["delete", "anonymize"],
  verification: ["delete", "archive"],
  audit_export: ["archive"],
};

export function isActionPermitted(
  resourceType: RetentionResourceType,
  action: RetentionAction,
): boolean {
  return PERMITTED_RETENTION_ACTIONS[resourceType].includes(action);
}

export type RetentionRuleId = Id<"RetentionRuleId">;

export interface RetentionRuleProps {
  readonly id: RetentionRuleId;
  readonly organizationId: string;
  readonly resourceType: RetentionResourceType;
  readonly retentionDays: number;
  readonly action: RetentionAction;
  readonly active: boolean;
}

/**
 * The declared lifetime of one category of data for one organization.
 *
 * This is the minimum the enforcement job needs. Rule versioning and
 * overlapping-rule rejection belong to the retention-rule model issue (#369)
 * and are not duplicated here.
 */
export class RetentionRule {
  private constructor(private readonly props: RetentionRuleProps) {}

  static create(params: {
    organizationId: string;
    resourceType: string;
    retentionDays: number;
    action: string;
  }): Result<RetentionRule, ValidationError> {
    const errors: Record<string, string[]> = {};
    const resourceType = RETENTION_RESOURCE_TYPES.find((t) => t === params.resourceType);
    const action = RETENTION_ACTIONS.find((a) => a === params.action);

    if (resourceType === undefined) errors["resourceType"] = ["unknown_resource_type"];
    if (action === undefined) errors["action"] = ["unknown_action"];
    if (!Number.isInteger(params.retentionDays) || params.retentionDays < 1) {
      errors["retentionDays"] = ["must_be_a_positive_integer"];
    }
    if (resourceType !== undefined && action !== undefined) {
      if (!isActionPermitted(resourceType, action)) {
        errors["action"] = [`not_permitted_for_${resourceType}`];
      }
    }
    if (Object.keys(errors).length > 0 || resourceType === undefined || action === undefined) {
      return Result.err(new ValidationError("Invalid retention rule.", errors));
    }

    return Result.ok(
      new RetentionRule({
        id: createId<"RetentionRuleId">(),
        organizationId: params.organizationId,
        resourceType,
        retentionDays: params.retentionDays,
        action,
        active: true,
      }),
    );
  }

  /** Rebuilds a rule from trusted stored data, without re-validating it. */
  static reconstitute(props: RetentionRuleProps): RetentionRule {
    return new RetentionRule(props);
  }

  get id(): RetentionRuleId {
    return this.props.id;
  }
  get organizationId(): string {
    return this.props.organizationId;
  }
  get resourceType(): RetentionResourceType {
    return this.props.resourceType;
  }
  get retentionDays(): number {
    return this.props.retentionDays;
  }
  get action(): RetentionAction {
    return this.props.action;
  }
  get active(): boolean {
    return this.props.active;
  }

  /** Records older than this instant are past retention at `now`. */
  cutoffAt(now: Date): Date {
    return new Date(now.getTime() - this.props.retentionDays * 24 * 60 * 60 * 1000);
  }
}
