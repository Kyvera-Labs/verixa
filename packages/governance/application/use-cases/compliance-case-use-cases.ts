import {
  AuthorizationError,
  NotFoundError,
  Result,
  type ConflictError,
  type DomainEventPublisher,
  type ValidationError,
} from "@verixa/shared-kernel";

import type { ApprovalDecision } from "../../domain/approval-chain.js";
import { ComplianceCase, type ComplianceCaseId } from "../../domain/compliance-case.js";
import type { WorkflowType } from "../../domain/workflow-definitions.js";
import type { ApproverEligibility } from "../ports/approver-eligibility.js";
import type {
  ComplianceCaseFilter,
  ComplianceCaseRepository,
} from "../ports/compliance-case-repository.js";

async function persist(
  repository: ComplianceCaseRepository,
  publisher: DomainEventPublisher,
  complianceCase: ComplianceCase,
): Promise<Result<ComplianceCase, ConflictError>> {
  const saved = await repository.save(complianceCase);
  if (Result.isErr(saved)) {
    return saved;
  }
  // Publish only after the save succeeded: an event must describe something
  // that is actually durable.
  for (const event of complianceCase.pendingEvents) {
    await publisher.publish(event);
  }
  return Result.ok(complianceCase);
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(`No compliance case found with id "${id}".`);
}

export class OpenComplianceCase {
  constructor(
    private readonly repository: ComplianceCaseRepository,
    private readonly publisher: DomainEventPublisher,
  ) {}

  async execute(command: {
    organizationId: string;
    workflowType: WorkflowType;
    title: string;
    actorId: string;
    assigneeId?: string | null;
  }): Promise<Result<ComplianceCase, ValidationError | ConflictError>> {
    const opened = ComplianceCase.open(command);
    if (Result.isErr(opened)) {
      return opened;
    }
    return persist(this.repository, this.publisher, opened.value);
  }
}

export class GetComplianceCase {
  constructor(private readonly repository: ComplianceCaseRepository) {}

  async execute(query: {
    organizationId: string;
    caseId: string;
  }): Promise<Result<ComplianceCase, NotFoundError>> {
    const found = await this.repository.findById(
      query.organizationId,
      query.caseId as ComplianceCaseId,
    );
    return found === undefined ? Result.err(notFound(query.caseId)) : Result.ok(found);
  }
}

export class ListComplianceCases {
  constructor(private readonly repository: ComplianceCaseRepository) {}

  execute(query: {
    organizationId: string;
    filter?: ComplianceCaseFilter;
  }): Promise<readonly ComplianceCase[]> {
    return this.repository.list(query.organizationId, query.filter ?? {});
  }
}

export class TransitionComplianceCase {
  constructor(
    private readonly repository: ComplianceCaseRepository,
    private readonly publisher: DomainEventPublisher,
  ) {}

  async execute(command: {
    organizationId: string;
    caseId: string;
    event: string;
    actorId: string;
    assigneeId?: string | null;
  }): Promise<Result<ComplianceCase, NotFoundError | ConflictError>> {
    const current = await this.repository.findById(
      command.organizationId,
      command.caseId as ComplianceCaseId,
    );
    if (current === undefined) {
      return Result.err(notFound(command.caseId));
    }
    const next = current.transition({
      event: command.event,
      actorId: command.actorId,
      ...(command.assigneeId === undefined ? {} : { assigneeId: command.assigneeId }),
    });
    if (Result.isErr(next)) {
      return next;
    }
    return persist(this.repository, this.publisher, next.value);
  }
}

export class RecordComplianceApproval {
  constructor(
    private readonly repository: ComplianceCaseRepository,
    private readonly publisher: DomainEventPublisher,
    private readonly eligibility: ApproverEligibility,
  ) {}

  async execute(command: {
    organizationId: string;
    caseId: string;
    role: string;
    approverId: string;
    decision: ApprovalDecision;
    comment?: string;
  }): Promise<
    Result<ComplianceCase, NotFoundError | AuthorizationError | ValidationError | ConflictError>
  > {
    const current = await this.repository.findById(
      command.organizationId,
      command.caseId as ComplianceCaseId,
    );
    if (current === undefined) {
      return Result.err(notFound(command.caseId));
    }
    // Eligibility is checked server-side, after the case is known to exist in
    // this organization, and before any decision is recorded.
    const eligible = await this.eligibility.canApproveAs(
      command.approverId,
      command.organizationId,
      command.role,
    );
    if (!eligible) {
      return Result.err(
        new AuthorizationError("You are not permitted to approve in the requested role."),
      );
    }
    const next = current.recordApproval({
      role: command.role,
      approverId: command.approverId,
      decision: command.decision,
      ...(command.comment === undefined ? {} : { comment: command.comment }),
    });
    if (Result.isErr(next)) {
      return next;
    }
    return persist(this.repository, this.publisher, next.value);
  }
}
