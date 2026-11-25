import type { ConflictError, Result } from "@verixa/shared-kernel";

import type { ComplianceCase, ComplianceCaseId } from "../../domain/compliance-case.js";
import type { WorkflowType } from "../../domain/workflow-definitions.js";

export interface ComplianceCaseFilter {
  readonly state?: string;
  readonly workflowType?: WorkflowType;
  readonly assigneeId?: string;
}

/**
 * Persistence for compliance cases.
 *
 * Every method is scoped by `organizationId`. An implementation must never
 * return, or let a caller modify, a case belonging to a different
 * organization: a lookup with the wrong organization answers `undefined`,
 * exactly as if the case did not exist, so ids cannot be probed across tenants.
 */
export interface ComplianceCaseRepository {
  /**
   * Persists `complianceCase`, which is either new (`version === 1`) or the
   * successor of the stored case (`version === stored.version + 1`).
   *
   * Any other version means the caller worked from a stale copy, and the
   * implementation must refuse with a `ConflictError` rather than overwrite:
   * two approvers acting at once must not silently lose one decision.
   */
  save(complianceCase: ComplianceCase): Promise<Result<void, ConflictError>>;

  findById(organizationId: string, id: ComplianceCaseId): Promise<ComplianceCase | undefined>;

  /** Cases matching every supplied filter, oldest first. */
  list(organizationId: string, filter: ComplianceCaseFilter): Promise<readonly ComplianceCase[]>;
}
