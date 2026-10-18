import {
  AUDIT_PERMISSIONS,
  ExportAuditEvents,
  InMemoryAuditEventReader,
  InMemoryAuditLogRepository,
  QueryAuditEvents,
  RecordAuditEvent,
} from "@verixa/audit";
import { AuditLogEntry } from "@verixa/audit/testing";
import Fastify from "fastify";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { handleApiError } from "../http/error-response.js";
import { versioning } from "../plugins/versioning.js";
import { registerAuditRoutes } from "./audit.js";

function makeChain(count: number, orgId: string, actorId = "user-1"): AuditLogEntry[] {
  const chain: AuditLogEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    chain.push(
      AuditLogEntry.append({
        action: "user.login_succeeded",
        actorId,
        metadata: { organizationId: orgId },
        previous: chain.at(-1),
      }),
    );
  }
  return chain;
}

describe("Audit REST routes", () => {
  let auditLog: InMemoryAuditLogRepository;
  let eventReader: InMemoryAuditEventReader;
  let recordAuditEvent: RecordAuditEvent;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    auditLog = new InMemoryAuditLogRepository();
    eventReader = new InMemoryAuditEventReader();
    recordAuditEvent = new RecordAuditEvent(auditLog);

    const queryEvents = new QueryAuditEvents(eventReader, recordAuditEvent);
    const exportEvents = new ExportAuditEvents(eventReader, recordAuditEvent);

    app = Fastify();
    app.setErrorHandler(handleApiError);
    await app.register(versioning);

    // Register under /v1/audit
    await app.register(
      async (scope) => {
        registerAuditRoutes(scope, {
          prisma: {} as any,
          eventPublisher: {} as any,
          identity: {} as any,
          credentials: {} as any,
          authorization: {} as any,
          mfa: {} as any,
          dispose: async () => {},
          audit: {
            recordEvent: recordAuditEvent,
            verifyChain: {} as any,
            anchor: undefined,
            queryEvents,
            exportEvents,
          },
        });
      },
      { prefix: "/v1/audit" },
    );

    await app.ready();
  });

  describe("GET /v1/audit", () => {
    it("returns paginated audit events for reader's organization", async () => {
      const own = makeChain(2, "org-test");
      const other = makeChain(1, "org-other", "intruder");
      eventReader.seed("org-test", ...own);
      eventReader.seed("org-other", ...other);

      const res = await supertest(app.server)
        .get("/v1/audit")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.query);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextCursor).toBeNull();
    });

    it("rejects unauthorized read without audit:query permission with 403", async () => {
      eventReader.seed("org-test", ...makeChain(1, "org-test"));

      const res = await supertest(app.server)
        .get("/v1/audit")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", "other:perm");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("AUDIT_ACCESS_DENIED");
    });

    it("supports cursor pagination with limit", async () => {
      const entries = makeChain(3, "org-test");
      eventReader.seed("org-test", ...entries);

      const res1 = await supertest(app.server)
        .get("/v1/audit?limit=2")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.query);

      expect(res1.status).toBe(200);
      expect(res1.body.items).toHaveLength(2);
      expect(res1.body.hasMore).toBe(true);
      expect(res1.body.nextCursor).toBeTruthy();

      const res2 = await supertest(app.server)
        .get(`/v1/audit?cursor=${res1.body.nextCursor}&limit=2`)
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.query);

      expect(res2.status).toBe(200);
      expect(res2.body.items).toHaveLength(1);
      expect(res2.body.hasMore).toBe(false);
    });
  });

  describe("GET /v1/audit/export", () => {
    it("streams CSV export with header", async () => {
      const entries = makeChain(1, "org-test", "user-1");
      eventReader.seed("org-test", ...entries);

      const res = await supertest(app.server)
        .get("/v1/audit/export?format=csv")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.export);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("sequence,action,actor_id,subject_id,occurred_at,previous_hash,hash,metadata");
      expect(res.text).toContain("user-1");
    });

    it("streams JSONL export", async () => {
      const entries = makeChain(1, "org-test", "user-1");
      eventReader.seed("org-test", ...entries);

      const res = await supertest(app.server)
        .get("/v1/audit/export?format=jsonl")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.export);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/x-ndjson");
      expect(res.text).toContain('"action":"user.login_succeeded"');
    });

    it("rejects unauthorized export with 403", async () => {
      const res = await supertest(app.server)
        .get("/v1/audit/export?format=csv")
        .set("x-actor-id", "auditor-1")
        .set("x-org-id", "org-test")
        .set("x-permissions", AUDIT_PERMISSIONS.query); // has query but NOT export

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("AUDIT_ACCESS_DENIED");
    });
  });
});
