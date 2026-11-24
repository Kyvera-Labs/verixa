import { ConflictError, InMemoryEventPublisher, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { ComplianceCase } from "../../domain/compliance-case.js";
import { InMemoryComplianceCaseRepository } from "../../infrastructure/in-memory-compliance-case-repository.js";

import {
  GetComplianceCase,
  OpenComplianceCase,
  RecordComplianceApproval,
  TransitionComplianceCase,
} from "./compliance-case-use-cases.js";

function setup(eligible = true) {
  const repository = new InMemoryComplianceCaseRepository();
  const publisher = new InMemoryEventPublisher();
  const published: string[] = [];
  publisher.subscribe("governance.compliance_case.opened", (e) => {
    published.push(e.eventName);
  });
  return {
    repository,
    published,
    open: new OpenComplianceCase(repository, publisher),
    get: new GetComplianceCase(repository),
    transition: new TransitionComplianceCase(repository, publisher),
    approve: new RecordComplianceApproval(repository, publisher, {
      canApproveAs: () => Promise.resolve(eligible),
    }),
  };
}

async function opened(s: ReturnType<typeof setup>): Promise<ComplianceCase> {
  const result = await s.open.execute({
    organizationId: "org_1",
    workflowType: "verification-review",
    title: "t",
    actorId: "u",
  });
  if (Result.isErr(result)) throw result.error;
  return result.value;
}

describe("compliance case use cases", () => {
  it("persists and publishes on open", async () => {
    const s = setup();
    const c = await opened(s);
    expect(await s.repository.findById("org_1", c.id)).toBeDefined();
    expect(s.published).toEqual(["governance.compliance_case.opened"]);
  });

  it("publishes nothing when the repository refuses the save", async () => {
    const s = setup();
    const refusing = {
      save: () => Promise.resolve(Result.err(new ConflictError("stale"))),
      findById: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
    };
    const publisher = new InMemoryEventPublisher();
    const seen: string[] = [];
    publisher.subscribe("governance.compliance_case.opened", (e) => {
      seen.push(e.eventName);
    });
    const result = await new OpenComplianceCase(refusing, publisher).execute({
      organizationId: "org_1",
      workflowType: "verification-review",
      title: "t",
      actorId: "u",
    });
    expect(Result.isErr(result)).toBe(true);
    expect(seen).toEqual([]);
    expect(s.published).toEqual([]);
  });

  it("refuses a lost update instead of overwriting", async () => {
    const s = setup();
    const c = await opened(s);
    const a = c.transition({ event: "begin_review", actorId: "a" });
    const b = c.transition({ event: "dismiss", actorId: "b" });
    if (Result.isErr(a) || Result.isErr(b)) throw new Error("setup");
    expect(Result.isOk(await s.repository.save(a.value))).toBe(true);
    const second = await s.repository.save(b.value);
    expect(Result.isErr(second)).toBe(true);
    if (Result.isErr(second)) expect(second.error).toBeInstanceOf(ConflictError);
    expect((await s.repository.findById("org_1", c.id))?.state).toBe("under_review");
  });

  it("answers not-found for a case in another organization", async () => {
    const s = setup();
    const c = await opened(s);
    const result = await s.get.execute({ organizationId: "org_2", caseId: c.id });
    expect(Result.isErr(result)).toBe(true);
    const moved = await s.transition.execute({
      organizationId: "org_2",
      caseId: c.id,
      event: "begin_review",
      actorId: "u",
    });
    expect(Result.isErr(moved)).toBe(true);
  });

  it("records nothing when the approver is ineligible", async () => {
    const s = setup(false);
    const c = await opened(s);
    const result = await s.approve.execute({
      organizationId: "org_1",
      caseId: c.id,
      role: "legal-counsel",
      approverId: "u2",
      decision: "approved",
    });
    expect(Result.isErr(result)).toBe(true);
    expect((await s.repository.findById("org_1", c.id))?.approvals).toEqual([]);
  });
});
