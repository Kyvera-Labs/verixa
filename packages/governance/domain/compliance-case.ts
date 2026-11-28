import {
  BaseDomainEvent,
  ConflictError,
  createId,
  Result,
  ValidationError,
  type DomainEvent,
  type Id,
} from "@verixa/shared-kernel";

import { ApprovalChain, type ApprovalDecision, type ApprovalRecord } from "./approval-chain.js";
import { getWorkflowDefinition, type WorkflowType } from "./workflow-definitions.js";

export type ComplianceCaseId = Id<"ComplianceCaseId">;

/**
 * One row of a case's state history. The first entry has `fromState: null`
 * (the case being opened). Entries are append-only; nothing edits or removes
 * one, which is what lets the history stand as evidence.
 */
export interface StateHistoryEntry {
  readonly fromState: string | null;
  readonly toState: string;
  /** The workflow event that caused the move; `opened` for the first entry. */
  readonly event: string;
  readonly actorId: string;
  readonly occurredAt: Date;
}

export class ComplianceCaseOpened extends BaseDomainEvent {
  readonly eventName = "governance.compliance_case.opened";
  constructor(
    caseId: ComplianceCaseId,
    readonly organizationId: string,
    readonly workflowType: WorkflowType,
    readonly actorId: string,
  ) {
    super(caseId);
  }
}

export class ComplianceCaseTransitioned extends BaseDomainEvent {
  readonly eventName = "governance.compliance_case.transitioned";
  constructor(
    caseId: ComplianceCaseId,
    readonly organizationId: string,
    readonly fromState: string,
    readonly toState: string,
    readonly event: string,
    readonly actorId: string,
  ) {
    super(caseId);
  }
}

/** Recorded for approvals and rejections alike: both are auditable decisions. */
export class ComplianceApprovalRecorded extends BaseDomainEvent {
  readonly eventName = "governance.compliance_case.approval_recorded";
  constructor(
    caseId: ComplianceCaseId,
    readonly organizationId: string,
    readonly role: string,
    readonly approverId: string,
    readonly decision: ApprovalDecision,
  ) {
    super(caseId);
  }
}

export interface ComplianceCaseProps {
  readonly id: ComplianceCaseId;
  readonly organizationId: string;
  readonly workflowType: WorkflowType;
  readonly title: string;
  readonly state: string;
  readonly assigneeId: string | null;
  readonly approvalChain: ApprovalChain;
  readonly history: readonly StateHistoryEntry[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Bumped on every change; repositories use it to reject lost updates. */
  readonly version: number;
}

/**
 * A compliance case moving through a workflow's transition table. Immutable; each operation returns
 * a new instance, and its events are available from {@link pendingEvents} until the case is
 * persisted and they are published. Callers name an event (`confirm`, `escalate`), never a target
 * state; the table decides where it leads.
 */
export class ComplianceCase {
  private constructor(
    private readonly props: ComplianceCaseProps,
    readonly pendingEvents: readonly DomainEvent[],
  ) {}

  static open(params: {
    organizationId: string;
    workflowType: WorkflowType;
    title: string;
    actorId: string;
    assigneeId?: string | null;
    now?: Date;
  }): Result<ComplianceCase, ValidationError> {
    const title = params.title.trim();
    if (title.length === 0) {
      return Result.err(new ValidationError("A case title is required.", { title: ["required"] }));
    }
    const definition = getWorkflowDefinition(params.workflowType);
    const now = params.now ?? new Date();
    const id = createId<"ComplianceCaseId">();

    return Result.ok(
      new ComplianceCase(
        {
          id,
          organizationId: params.organizationId,
          workflowType: params.workflowType,
          title,
          state: definition.initialState,
          assigneeId: params.assigneeId ?? null,
          approvalChain: ApprovalChain.create(definition.approvalRoles),
          history: [
            {
              fromState: null,
              toState: definition.initialState,
              event: "opened",
              actorId: params.actorId,
              occurredAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
          version: 1,
        },
        [new ComplianceCaseOpened(id, params.organizationId, params.workflowType, params.actorId)],
      ),
    );
  }

  /** Rebuilds a case from trusted persisted data. Raises no events. */
  static reconstitute(props: ComplianceCaseProps): ComplianceCase {
    return new ComplianceCase(props, []);
  }

  get id(): ComplianceCaseId {
    return this.props.id;
  }
  get organizationId(): string {
    return this.props.organizationId;
  }
  get workflowType(): WorkflowType {
    return this.props.workflowType;
  }
  get title(): string {
    return this.props.title;
  }
  get state(): string {
    return this.props.state;
  }
  get assigneeId(): string | null {
    return this.props.assigneeId;
  }
  get approvalChain(): ApprovalChain {
    return this.props.approvalChain;
  }
  get history(): readonly StateHistoryEntry[] {
    return this.props.history;
  }
  get approvals(): readonly ApprovalRecord[] {
    return this.props.approvalChain.records;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get version(): number {
    return this.props.version;
  }
  get isTerminal(): boolean {
    return getWorkflowDefinition(this.props.workflowType).terminalStates.includes(this.props.state);
  }

  /** Events this case should accept now, for clients that want to render actions. */
  get availableEvents(): readonly string[] {
    const table = getWorkflowDefinition(this.props.workflowType).transitions;
    return Object.keys(table[this.props.state] ?? {});
  }

  /**
   * Applies a workflow event. Refused when the table has no edge for
   * `(state, event)`, and, for a gated edge, until every approval slot is
   * filled. `assigneeId` optionally hands the case to someone as part of the
   * move (`null` unassigns, `undefined` leaves it alone).
   */
  transition(params: {
    event: string;
    actorId: string;
    assigneeId?: string | null;
    now?: Date;
  }): Result<ComplianceCase, ConflictError> {
    const definition = getWorkflowDefinition(this.props.workflowType);
    const rule = definition.transitions[this.props.state]?.[params.event];

    if (rule === undefined) {
      return Result.err(
        new ConflictError(
          `Event "${params.event}" is not allowed from state "${this.props.state}" in a ${this.props.workflowType} case.`,
        ),
      );
    }

    if (rule.gated === true) {
      const chain = this.props.approvalChain;
      if (chain.isRejected) {
        return Result.err(
          new ConflictError(`Event "${params.event}" is blocked: an approver rejected this case.`),
        );
      }
      if (!chain.isSatisfied) {
        return Result.err(
          new ConflictError(
            `Event "${params.event}" requires approval from: ${chain.pendingRoles.join(", ")}.`,
          ),
        );
      }
    }

    const now = params.now ?? new Date();
    return Result.ok(
      new ComplianceCase(
        {
          ...this.props,
          state: rule.to,
          assigneeId: params.assigneeId === undefined ? this.props.assigneeId : params.assigneeId,
          history: [
            ...this.props.history,
            {
              fromState: this.props.state,
              toState: rule.to,
              event: params.event,
              actorId: params.actorId,
              occurredAt: now,
            },
          ],
          updatedAt: now,
          version: this.props.version + 1,
        },
        [
          new ComplianceCaseTransitioned(
            this.props.id,
            this.props.organizationId,
            this.props.state,
            rule.to,
            params.event,
            params.actorId,
          ),
        ],
      ),
    );
  }

  /** Records an approval or rejection against one of the chain's slots. */
  recordApproval(params: {
    role: string;
    approverId: string;
    decision: ApprovalDecision;
    comment?: string;
    now?: Date;
  }): Result<ComplianceCase, ValidationError | ConflictError> {
    if (this.isTerminal) {
      return Result.err(
        new ConflictError(
          `Case is in terminal state "${this.props.state}" and takes no approvals.`,
        ),
      );
    }
    const now = params.now ?? new Date();
    const next = this.props.approvalChain.record({
      role: params.role,
      approverId: params.approverId,
      decision: params.decision,
      decidedAt: now,
      ...(params.comment === undefined ? {} : { comment: params.comment }),
    });
    if (Result.isErr(next)) {
      return next;
    }
    return Result.ok(
      new ComplianceCase(
        {
          ...this.props,
          approvalChain: next.value,
          updatedAt: now,
          version: this.props.version + 1,
        },
        [
          new ComplianceApprovalRecorded(
            this.props.id,
            this.props.organizationId,
            params.role,
            params.approverId,
            params.decision,
          ),
        ],
      ),
    );
  }
}
