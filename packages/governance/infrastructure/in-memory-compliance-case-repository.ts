import { ConflictError, Result } from "@verixa/shared-kernel";

import type {
  ComplianceCaseFilter,
  ComplianceCaseRepository,
} from "../application/ports/compliance-case-repository.js";
import type { ComplianceCase, ComplianceCaseId } from "../domain/compliance-case.js";

/**
 * Process-local implementation of the repository contract. Cases are lost on
 * restart and are not shared between API instances, so this is for tests and
 * single-process development; a database-backed adapter is the production
 * follow-up. It enforces the same organization scoping and version check the
 * port documents, so tests against it exercise the real contract.
 */
export class InMemoryComplianceCaseRepository implements ComplianceCaseRepository {
  private readonly cases = new Map<string, ComplianceCase>();

  save(complianceCase: ComplianceCase): Promise<Result<void, ConflictError>> {
    const stored = this.cases.get(complianceCase.id);
    const expectedVersion = stored === undefined ? 1 : stored.version + 1;
    if (
      complianceCase.version !== expectedVersion ||
      (stored !== undefined && stored.organizationId !== complianceCase.organizationId)
    ) {
      return Promise.resolve(
        Result.err(new ConflictError("The case was modified concurrently; reload and retry.")),
      );
    }
    this.cases.set(complianceCase.id, complianceCase);
    return Promise.resolve(Result.ok(undefined));
  }

  findById(organizationId: string, id: ComplianceCaseId): Promise<ComplianceCase | undefined> {
    const found = this.cases.get(id);
    return Promise.resolve(found?.organizationId === organizationId ? found : undefined);
  }

  list(organizationId: string, filter: ComplianceCaseFilter): Promise<readonly ComplianceCase[]> {
    const matches = [...this.cases.values()]
      .filter((c) => c.organizationId === organizationId)
      .filter((c) => filter.state === undefined || c.state === filter.state)
      .filter((c) => filter.workflowType === undefined || c.workflowType === filter.workflowType)
      .filter((c) => filter.assigneeId === undefined || c.assigneeId === filter.assigneeId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return Promise.resolve(matches);
  }
}
