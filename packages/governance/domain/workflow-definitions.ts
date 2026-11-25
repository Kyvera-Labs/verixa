/**
 * Compliance workflow definitions, expressed as data.
 *
 * The transition table below is the single place a compliance auditor needs to
 * read to learn which moves a case may make. `ComplianceCase` contains no
 * per-workflow `if`/`switch`; it looks the move up here. Adding a workflow type
 * is therefore a data change that does not touch the aggregate.
 *
 * Alternative rejected: one subclass per workflow overriding a `canTransition`
 * method. That spreads the rules across files and turns "what can happen from
 * state X" into a question answered by reading code paths, not a table.
 */

export const WORKFLOW_TYPES = ["verification-review", "data-subject-request"] as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export function isWorkflowType(value: string): value is WorkflowType {
  return (WORKFLOW_TYPES as readonly string[]).includes(value);
}

/** One legal edge of the state machine. */
export interface TransitionRule {
  /** The state the case moves to. */
  readonly to: string;
  /**
   * When true the move is a gated transition: it is refused until the case's
   * approval chain is fully satisfied (and refused for good if any approver
   * rejected).
   */
  readonly gated?: boolean;
}

export interface WorkflowDefinition {
  readonly type: WorkflowType;
  readonly initialState: string;
  /** A case in a terminal state accepts no further events. */
  readonly terminalStates: readonly string[];
  /**
   * `state -> event -> rule`. A missing entry means the event is illegal in
   * that state; there is deliberately no wildcard or fallback.
   */
  readonly transitions: Readonly<Record<string, Readonly<Record<string, TransitionRule>>>>;
  /**
   * Approver roles that must each sign off before a gated transition. Each
   * role is one slot, and one person can fill only one slot.
   */
  readonly approvalRoles: readonly string[];
}

const verificationReview: WorkflowDefinition = {
  type: "verification-review",
  initialState: "flagged",
  terminalStates: ["confirmed", "dismissed"],
  approvalRoles: ["compliance-officer", "legal-counsel"],
  transitions: {
    flagged: {
      begin_review: { to: "under_review" },
      dismiss: { to: "dismissed" },
    },
    under_review: {
      escalate: { to: "escalated" },
      dismiss: { to: "dismissed" },
      confirm: { to: "confirmed", gated: true },
    },
    escalated: {
      dismiss: { to: "dismissed" },
      confirm: { to: "confirmed", gated: true },
    },
  },
};

const dataSubjectRequest: WorkflowDefinition = {
  type: "data-subject-request",
  initialState: "received",
  terminalStates: ["fulfilled", "rejected"],
  approvalRoles: ["compliance-officer", "data-protection-officer"],
  transitions: {
    received: {
      verify_identity: { to: "identity_verified" },
      reject: { to: "rejected" },
    },
    identity_verified: {
      start_fulfilment: { to: "in_progress" },
      reject: { to: "rejected" },
    },
    in_progress: {
      fulfil: { to: "fulfilled", gated: true },
      reject: { to: "rejected" },
    },
  },
};

export const WORKFLOW_DEFINITIONS: Readonly<Record<WorkflowType, WorkflowDefinition>> = {
  "verification-review": verificationReview,
  "data-subject-request": dataSubjectRequest,
};

export function getWorkflowDefinition(type: WorkflowType): WorkflowDefinition {
  return WORKFLOW_DEFINITIONS[type];
}
