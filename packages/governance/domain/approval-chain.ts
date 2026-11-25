import { ConflictError, Result, ValidationError } from "@verixa/shared-kernel";

export type ApprovalDecision = "approved" | "rejected";

/** One approver's recorded decision. Kept forever; it is the audit record. */
export interface ApprovalRecord {
  readonly role: string;
  readonly approverId: string;
  readonly decision: ApprovalDecision;
  readonly decidedAt: Date;
  readonly comment?: string;
}

/**
 * The sign-offs a case needs before a gated transition, with partial-approval
 * tracking. Immutable: every operation returns a new chain.
 *
 * Each required role is one slot. A slot is filled by an approval for that
 * role, and a single approver can record at most one decision across the whole
 * chain, so one person holding two roles cannot satisfy two-person review
 * alone.
 */
export class ApprovalChain {
  private constructor(
    readonly requiredRoles: readonly string[],
    readonly records: readonly ApprovalRecord[],
  ) {}

  static create(requiredRoles: readonly string[]): ApprovalChain {
    return new ApprovalChain([...new Set(requiredRoles)], []);
  }

  static reconstitute(
    requiredRoles: readonly string[],
    records: readonly ApprovalRecord[],
  ): ApprovalChain {
    return new ApprovalChain(requiredRoles, records);
  }

  /** Required roles that have a recorded approval. */
  get approvedRoles(): readonly string[] {
    return this.requiredRoles.filter((role) =>
      this.records.some((r) => r.role === role && r.decision === "approved"),
    );
  }

  get pendingRoles(): readonly string[] {
    const approved = new Set(this.approvedRoles);
    return this.requiredRoles.filter((role) => !approved.has(role));
  }

  get isRejected(): boolean {
    return this.records.some((r) => r.decision === "rejected");
  }

  /** True only when every slot is approved and nobody rejected. */
  get isSatisfied(): boolean {
    return this.requiredRoles.length > 0 && this.pendingRoles.length === 0 && !this.isRejected;
  }

  record(params: {
    role: string;
    approverId: string;
    decision: ApprovalDecision;
    decidedAt: Date;
    comment?: string;
  }): Result<ApprovalChain, ValidationError | ConflictError> {
    if (!this.requiredRoles.includes(params.role)) {
      return Result.err(
        new ValidationError(`"${params.role}" is not a required approver role for this case.`, {
          role: ["not_required"],
        }),
      );
    }
    if (this.isRejected) {
      return Result.err(new ConflictError("This approval chain has already been rejected."));
    }
    if (this.records.some((r) => r.approverId === params.approverId)) {
      return Result.err(
        new ConflictError("This approver has already recorded a decision on this case."),
      );
    }
    if (this.approvedRoles.includes(params.role)) {
      return Result.err(new ConflictError(`The "${params.role}" approval slot is already filled.`));
    }

    const entry: ApprovalRecord = {
      role: params.role,
      approverId: params.approverId,
      decision: params.decision,
      decidedAt: params.decidedAt,
      ...(params.comment === undefined ? {} : { comment: params.comment }),
    };
    return Result.ok(new ApprovalChain(this.requiredRoles, [...this.records, entry]));
  }
}
