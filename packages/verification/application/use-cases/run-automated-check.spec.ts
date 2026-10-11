import { createId, NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Evidence } from "../../domain/entities/evidence.js";
import { VerificationRequest } from "../../domain/entities/verification-request.js";
import { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import { VerificationType } from "../../domain/value-objects/verification-type.js";
import { InMemoryVerificationRequestRepository } from "../../infrastructure/testing/in-memory-verification-request-repository.js";
import { ProviderCheckResult } from "../dtos/provider-check-result.js";
import type { VerificationProvider } from "../ports/verification-provider.js";

import { RunAutomatedCheck } from "./run-automated-check.js";

const CHECKSUM = "a".repeat(64);

class FakeVerificationProvider implements VerificationProvider {
  constructor(
    private readonly documentResult:
      ProviderCheckResult | Error = ProviderCheckResult.inconclusive(),
    private readonly livenessResult:
      ProviderCheckResult | Error = ProviderCheckResult.inconclusive(),
  ) {}

  checkDocument(): Promise<ProviderCheckResult> {
    if (this.documentResult instanceof Error) throw this.documentResult;
    return Promise.resolve(this.documentResult);
  }

  checkLiveness(): Promise<ProviderCheckResult> {
    if (this.livenessResult instanceof Error) throw this.livenessResult;
    return Promise.resolve(this.livenessResult);
  }
}

function newSubmittedRequest(): VerificationRequest {
  const request = VerificationRequest.request({
    subjectUserId: createId<"VerificationSubjectId">(),
    organizationId: createId<"VerificationOrganizationId">(),
    type: VerificationType.reconstitute("identity-document"),
  });
  const submitted = request.submit();
  if (Result.isErr(submitted)) throw new Error("fixture setup failed");
  return submitted.value;
}

function attachDocument(requestId: ReturnType<typeof createId<"VerificationRequestId">>): Evidence {
  const attached = Evidence.attach({
    requestId,
    verificationType: VerificationType.reconstitute("identity-document"),
    evidenceType: "government-id-front",
    storageRef: "evidence/front.jpg",
    checksum: CHECKSUM,
  });
  if (Result.isErr(attached)) throw new Error("fixture setup failed");
  return attached.value;
}

async function setup(provider: VerificationProvider): Promise<{
  repository: InMemoryVerificationRequestRepository;
  request: VerificationRequest;
  evidence: Evidence;
  useCase: RunAutomatedCheck;
}> {
  const repository = new InMemoryVerificationRequestRepository();
  const request = newSubmittedRequest();
  await repository.save(request);
  const evidence = attachDocument(request.id);
  return { repository, request, evidence, useCase: new RunAutomatedCheck(repository, provider) };
}

describe("RunAutomatedCheck", () => {
  it("records a passing provider result and moves the request to in_review", async () => {
    const passed = ProviderCheckResult.passed("vendor-ref-1");
    const { request, evidence, useCase, repository } = await setup(
      new FakeVerificationProvider(passed),
    );

    const result = await useCase.execute({ requestId: request.id, evidence: [evidence] });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isErr(result)) return;
    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.checkResults).toEqual([{ evidenceId: evidence.id, result: passed }]);

    const persisted = await repository.findById(request.id);
    expect(persisted?.status.value).toBe("in_review");
  });

  it("records a failing provider result and still moves the request to in_review", async () => {
    const failed = ProviderCheckResult.failed("vendor-ref-2");
    const { request, evidence, useCase } = await setup(new FakeVerificationProvider(failed));

    const result = await useCase.execute({ requestId: request.id, evidence: [evidence] });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isErr(result)) return;
    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.checkResults).toEqual([{ evidenceId: evidence.id, result: failed }]);
  });

  it("records an inconclusive provider result and moves the request to in_review", async () => {
    const inconclusive = ProviderCheckResult.inconclusive();
    const { request, evidence, useCase } = await setup(new FakeVerificationProvider(inconclusive));

    const result = await useCase.execute({ requestId: request.id, evidence: [evidence] });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isErr(result)) return;
    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.checkResults).toEqual([{ evidenceId: evidence.id, result: inconclusive }]);
  });

  it("treats a provider error as inconclusive and still routes to in_review", async () => {
    const { request, evidence, useCase } = await setup(
      new FakeVerificationProvider(new Error("Provider timeout")),
    );

    const result = await useCase.execute({ requestId: request.id, evidence: [evidence] });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isErr(result)) return;
    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.checkResults).toEqual([
      { evidenceId: evidence.id, result: ProviderCheckResult.inconclusive() },
    ]);
  });

  it("checks a selfie against checkLiveness rather than checkDocument", async () => {
    const livenessResult = ProviderCheckResult.passed("liveness-ref");
    const repository = new InMemoryVerificationRequestRepository();
    const request = newSubmittedRequest();
    await repository.save(request);
    const selfie = Evidence.attach({
      requestId: request.id,
      verificationType: VerificationType.reconstitute("liveness"),
      evidenceType: "selfie",
      storageRef: "evidence/selfie.jpg",
      checksum: CHECKSUM,
    });
    if (Result.isErr(selfie)) throw new Error("fixture setup failed");

    const provider = new FakeVerificationProvider(
      ProviderCheckResult.inconclusive(),
      livenessResult,
    );
    const useCase = new RunAutomatedCheck(repository, provider);

    const result = await useCase.execute({ requestId: request.id, evidence: [selfie.value] });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isErr(result)) return;
    expect(result.value.checkResults).toEqual([
      { evidenceId: selfie.value.id, result: livenessResult },
    ]);
  });

  it("returns NotFoundError for an unknown request", async () => {
    const repository = new InMemoryVerificationRequestRepository();
    const useCase = new RunAutomatedCheck(repository, new FakeVerificationProvider());

    const result = await useCase.execute({
      requestId: createId<"VerificationRequestId">(),
      evidence: [],
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it("rejects evidence that does not belong to the request", async () => {
    const { request, useCase, repository } = await setup(new FakeVerificationProvider());
    const otherRequest = newSubmittedRequest();
    await repository.save(otherRequest);
    const foreignEvidence = attachDocument(otherRequest.id);

    const result = await useCase.execute({ requestId: request.id, evidence: [foreignEvidence] });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("refuses to run a check on a request that is not submitted", async () => {
    const repository = new InMemoryVerificationRequestRepository();
    const pending = VerificationRequest.request({
      subjectUserId: createId<"VerificationSubjectId">(),
      organizationId: createId<"VerificationOrganizationId">(),
      type: VerificationType.reconstitute("identity-document"),
    });
    await repository.save(pending);
    const useCase = new RunAutomatedCheck(repository, new FakeVerificationProvider());

    const result = await useCase.execute({ requestId: pending.id, evidence: [] });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeInstanceOf(InvalidStatusTransitionError);
    }
  });
});
