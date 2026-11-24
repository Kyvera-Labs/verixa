import { InMemoryEventPublisher, type DomainEvent } from "@verixa/shared-kernel";
import Fastify, { type FastifyInstance } from "fastify";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GetComplianceCase,
  ListComplianceCases,
  OpenComplianceCase,
  RecordComplianceApproval,
  TransitionComplianceCase,
} from "../../application/use-cases/compliance-case-use-cases.js";
import { InMemoryComplianceCaseRepository } from "../../infrastructure/in-memory-compliance-case-repository.js";

import { registerComplianceCaseRoutes } from "./compliance-case-routes.js";

interface CaseBody {
  id: string;
  state: string;
  availableEvents: string[];
  approvals: { pendingRoles: string[]; records: { approverId: string }[] };
  history: { event: string; actorId: string }[];
  items: { title: string }[];
  error: { code: string; message: string };
}

function json(res: { body: unknown }): CaseBody {
  return res.body as CaseBody;
}

/** user -> organization -> permissions. Anything not listed is denied. */
const GRANTS: Record<string, Record<string, readonly string[]>> = {
  officer: {
    org_a: [
      "compliance-cases:read",
      "compliance-cases:write",
      "compliance-cases:approve",
      "compliance-cases:approve:compliance-officer",
    ],
  },
  counsel: {
    org_a: [
      "compliance-cases:read",
      "compliance-cases:approve",
      "compliance-cases:approve:legal-counsel",
    ],
  },
  // Holds the approve permission but only for a role it is not allowed to use.
  impostor: { org_a: ["compliance-cases:read", "compliance-cases:approve"] },
  reader: { org_a: ["compliance-cases:read"] },
  other_org_admin: {
    org_b: ["compliance-cases:read", "compliance-cases:write", "compliance-cases:approve"],
  },
};

function has(userId: string, orgId: string, permission: string): boolean {
  return GRANTS[userId]?.[orgId]?.includes(permission) ?? false;
}

describe("compliance case routes", () => {
  let app: FastifyInstance;
  let events: DomainEvent[];
  const base = "/admin/organizations/org_a/compliance-cases";

  beforeEach(async () => {
    const repository = new InMemoryComplianceCaseRepository();
    const publisher = new InMemoryEventPublisher();
    events = [];
    for (const name of [
      "governance.compliance_case.opened",
      "governance.compliance_case.transitioned",
      "governance.compliance_case.approval_recorded",
    ]) {
      publisher.subscribe(name, (e) => {
        events.push(e);
      });
    }
    const permissions = {
      hasPermission: (u: string, o: string, p: string) => Promise.resolve(has(u, o, p)),
    };
    app = Fastify();
    await app.register(
      (scope, _opts, done) => {
        registerComplianceCaseRoutes(scope, {
          openCase: new OpenComplianceCase(repository, publisher),
          getCase: new GetComplianceCase(repository),
          listCases: new ListComplianceCases(repository),
          transitionCase: new TransitionComplianceCase(repository, publisher),
          recordApproval: new RecordComplianceApproval(repository, publisher, {
            canApproveAs: (u, o, role) =>
              Promise.resolve(has(u, o, `compliance-cases:approve:${role}`)),
          }),
          permissions,
        });
        done();
      },
      { prefix: "/admin" },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (user: string) => ({ "x-user-id": user });

  async function createCase(
    body: object = { workflowType: "verification-review", title: "Flagged ID" },
  ) {
    const res = await supertest(app.server).post(base).set(as("officer")).send(body);
    expect(res.status).toBe(201);
    return json(res) as { id: string };
  }

  it("runs a full lifecycle, including approval gating, and records history", async () => {
    const { id } = await createCase();
    const url = `${base}/${id}`;

    for (const event of ["begin_review", "escalate"]) {
      const res = await supertest(app.server)
        .post(`${url}/transitions`)
        .set(as("officer"))
        .send({ event });
      expect(res.status).toBe(200);
    }

    // Gated: refused until both roles approve.
    const early = await supertest(app.server)
      .post(`${url}/transitions`)
      .set(as("officer"))
      .send({ event: "confirm" });
    expect(early.status).toBe(409);

    const first = await supertest(app.server)
      .post(`${url}/approvals`)
      .set(as("officer"))
      .send({ role: "compliance-officer", decision: "approved" });
    expect(first.status).toBe(200);
    expect(json(first).approvals.pendingRoles).toEqual(["legal-counsel"]);

    const stillBlocked = await supertest(app.server)
      .post(`${url}/transitions`)
      .set(as("officer"))
      .send({ event: "confirm" });
    expect(stillBlocked.status).toBe(409);

    await supertest(app.server)
      .post(`${url}/approvals`)
      .set(as("counsel"))
      .send({ role: "legal-counsel", decision: "approved", comment: "reviewed" })
      .expect(200);

    const confirmed = await supertest(app.server)
      .post(`${url}/transitions`)
      .set(as("officer"))
      .send({ event: "confirm" });
    expect(confirmed.status).toBe(200);
    expect(json(confirmed).state).toBe("confirmed");
    expect(json(confirmed).availableEvents).toEqual([]);

    const fetched = await supertest(app.server).get(url).set(as("reader"));
    expect(fetched.status).toBe(200);
    expect(
      json(fetched).history.map((h: { event: string; actorId: string }) => [h.event, h.actorId]),
    ).toEqual([
      ["opened", "officer"],
      ["begin_review", "officer"],
      ["escalate", "officer"],
      ["confirm", "officer"],
    ]);
    expect(
      json(fetched).approvals.records.map((r: { approverId: string }) => r.approverId),
    ).toEqual(["officer", "counsel"]);

    // Opening, three transitions, two approvals: all published.
    expect(events.map((e) => e.eventName)).toEqual([
      "governance.compliance_case.opened",
      "governance.compliance_case.transitioned",
      "governance.compliance_case.transitioned",
      "governance.compliance_case.approval_recorded",
      "governance.compliance_case.approval_recorded",
      "governance.compliance_case.transitioned",
    ]);
  });

  it("rejects an illegal transition and leaves the case unchanged", async () => {
    const { id } = await createCase();
    const res = await supertest(app.server)
      .post(`${base}/${id}/transitions`)
      .set(as("officer"))
      .send({ event: "confirm" });
    expect(res.status).toBe(409);
    expect(json(res).error.code).toBe("CONFLICT");

    const after = await supertest(app.server).get(`${base}/${id}`).set(as("officer"));
    expect(json(after).state).toBe("flagged");
    expect(json(after).history).toHaveLength(1);
  });

  it("does not trust a client-asserted state", async () => {
    const { id } = await createCase();
    // Fastify's validator strips unknown keys, so these never reach the domain.
    const res = await supertest(app.server)
      .post(`${base}/${id}/transitions`)
      .set(as("officer"))
      .send({ event: "begin_review", state: "confirmed", toState: "confirmed" });
    expect(res.status).toBe(200);
    expect(json(res).state).toBe("under_review");

    // A target state name is not an event, so it cannot be used to jump there.
    const asEvent = await supertest(app.server)
      .post(`${base}/${id}/transitions`)
      .set(as("officer"))
      .send({ event: "confirmed" });
    expect(asEvent.status).toBe(409);
    const after = await supertest(app.server).get(`${base}/${id}`).set(as("officer"));
    expect(json(after).state).toBe("under_review");
  });

  it("filters the list by state, type and assignee", async () => {
    const a = await createCase({
      workflowType: "verification-review",
      title: "A",
      assigneeId: "usr_x",
    });
    await createCase({ workflowType: "data-subject-request", title: "B", assigneeId: "usr_y" });
    await createCase({ workflowType: "verification-review", title: "C" });
    await supertest(app.server)
      .post(`${base}/${a.id}/transitions`)
      .set(as("officer"))
      .send({ event: "begin_review" })
      .expect(200);

    const titles = async (query: string) => {
      const res = await supertest(app.server).get(`${base}${query}`).set(as("reader"));
      expect(res.status).toBe(200);
      return json(res).items.map((i: { title: string }) => i.title);
    };

    expect(await titles("")).toEqual(["A", "B", "C"]);
    expect(await titles("?type=data-subject-request")).toEqual(["B"]);
    expect(await titles("?state=under_review")).toEqual(["A"]);
    expect(await titles("?state=flagged")).toEqual(["C"]);
    expect(await titles("?assignee=usr_y")).toEqual(["B"]);
    expect(await titles("?type=verification-review&assignee=usr_x&state=under_review")).toEqual([
      "A",
    ]);
    expect(await titles("?assignee=nobody")).toEqual([]);
  });

  it("validates request shape", async () => {
    const bad = [
      { workflowType: "nope", title: "x" },
      { workflowType: "verification-review", title: "" },
      { workflowType: "verification-review" },
    ];
    for (const body of bad) {
      const res = await supertest(app.server).post(base).set(as("officer")).send(body);
      expect(res.status).toBe(400);
    }
    const list = await supertest(app.server).get(`${base}?type=bogus`).set(as("reader"));
    expect(list.status).toBe(400);
  });

  it("denies unauthenticated callers and callers without the permission", async () => {
    const { id } = await createCase();
    const noUser = await supertest(app.server).get(base);
    expect(noUser.status).toBe(403);

    const readerWrites = await supertest(app.server)
      .post(base)
      .set(as("reader"))
      .send({ workflowType: "verification-review", title: "x" });
    expect(readerWrites.status).toBe(403);
    const readerTransitions = await supertest(app.server)
      .post(`${base}/${id}/transitions`)
      .set(as("reader"))
      .send({ event: "begin_review" });
    expect(readerTransitions.status).toBe(403);
    // The body must not reveal which permission was missing.
    expect(JSON.stringify(json(readerTransitions))).not.toContain("compliance-cases");
  });

  it("scopes everything to the organization in the path", async () => {
    const { id } = await createCase();

    // A user with rights in another org gets nothing in org_a.
    const read = await supertest(app.server).get(`${base}/${id}`).set(as("other_org_admin"));
    expect(read.status).toBe(403);

    // Even in their own org, the id of org_a's case does not resolve.
    const crossOrg = await supertest(app.server)
      .get(`/admin/organizations/org_b/compliance-cases/${id}`)
      .set(as("other_org_admin"));
    expect(crossOrg.status).toBe(404);
    const crossTransition = await supertest(app.server)
      .post(`/admin/organizations/org_b/compliance-cases/${id}/transitions`)
      .set(as("other_org_admin"))
      .send({ event: "begin_review" });
    expect(crossTransition.status).toBe(404);

    const listB = await supertest(app.server)
      .get("/admin/organizations/org_b/compliance-cases")
      .set(as("other_org_admin"));
    expect(json(listB).items).toEqual([]);
  });

  it("refuses an approval in a role the caller is not eligible for", async () => {
    const { id } = await createCase();
    const res = await supertest(app.server)
      .post(`${base}/${id}/approvals`)
      .set(as("impostor"))
      .send({ role: "legal-counsel", decision: "approved" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(json(res))).not.toContain("legal-counsel");
    const after = await supertest(app.server).get(`${base}/${id}`).set(as("officer"));
    expect(json(after).approvals.records).toEqual([]);
  });

  it("refuses a second decision from the same approver", async () => {
    const { id } = await createCase();
    const url = `${base}/${id}/approvals`;
    await supertest(app.server)
      .post(url)
      .set(as("officer"))
      .send({ role: "compliance-officer", decision: "approved" })
      .expect(200);
    const again = await supertest(app.server)
      .post(url)
      .set(as("officer"))
      .send({ role: "compliance-officer", decision: "approved" });
    expect(again.status).toBe(409);
  });

  it("blocks a gated transition after a recorded rejection", async () => {
    const { id } = await createCase();
    const url = `${base}/${id}`;
    await supertest(app.server)
      .post(`${url}/transitions`)
      .set(as("officer"))
      .send({ event: "begin_review" });
    await supertest(app.server)
      .post(`${url}/approvals`)
      .set(as("counsel"))
      .send({ role: "legal-counsel", decision: "rejected" })
      .expect(200);
    await supertest(app.server)
      .post(`${url}/approvals`)
      .set(as("officer"))
      .send({ role: "compliance-officer", decision: "approved" })
      .expect(409);
    await supertest(app.server)
      .post(`${url}/transitions`)
      .set(as("officer"))
      .send({ event: "confirm" })
      .expect(409);
  });

  it("answers 404 for an unknown case", async () => {
    const res = await supertest(app.server).get(`${base}/missing`).set(as("reader"));
    expect(res.status).toBe(404);
  });
});
