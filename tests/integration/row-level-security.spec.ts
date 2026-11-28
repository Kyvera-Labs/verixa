import { createPrismaClient, type PrismaClient } from "@verixa/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  databaseAvailability,
  testDatabaseUrl,
} from "./helpers/database.js";

/**
 * Proves Row-Level Security isolates tenants. Superusers bypass RLS, and the default `verixa` test
 * role is a superuser, so this suite connects as a dedicated unprivileged role. Production must
 * likewise never connect as a superuser.
 */

const available = await databaseAvailability();

const APP_ROLE = "verixa_rls_test";
// Local/CI test fixture only. Never a real credential: this role exists only
// inside a throwaway test database and has no privileges beyond the tables
// below. See docs/security/token-storage.md on why fixtures must be
// obviously worthless.
const APP_PASSWORD = "not-a-secret-test-only";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const OWNER_A = "00000000-0000-4000-8000-0000000000a2";
const OWNER_B = "00000000-0000-4000-8000-0000000000b2";

function restrictedUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

describe.skipIf(!available)("row-level security", () => {
  const admin = createTestPrismaClient();
  let app: PrismaClient;

  beforeAll(async () => {
    // Idempotent role creation, since roles survive database resets. These statements interpolate
    // rather than bind because DDL takes identifiers, not values. It is safe only because
    // `APP_ROLE` and `APP_PASSWORD` are constants in this file; making either a runtime value would
    // make this unsafe (see docs/security/injection-hardening.md).
    /* eslint-disable no-restricted-syntax -- DDL identifiers cannot be bound; see the comment above */
    await admin.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
        END IF;
      END
      $$;
    `);
    await admin.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};`,
    );
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE};`);
    /* eslint-enable no-restricted-syntax */

    await admin.invitation.deleteMany({});
    await admin.organizationMembership.deleteMany({});
    await admin.organization.deleteMany({});
    await admin.user.deleteMany({});

    const now = new Date();
    await admin.user.createMany({
      data: [
        {
          id: OWNER_A,
          email: "owner-a@example.com",
          displayName: "Owner A",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: OWNER_B,
          email: "owner-b@example.com",
          displayName: "Owner B",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await admin.organization.createMany({
      data: [
        {
          id: ORG_A,
          name: "Tenant A",
          slug: "tenant-a",
          ownerId: OWNER_A,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: ORG_B,
          name: "Tenant B",
          slug: "tenant-b",
          ownerId: OWNER_B,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await admin.organizationMembership.createMany({
      data: [
        {
          id: "00000000-0000-4000-8000-0000000000a3",
          userId: OWNER_A,
          organizationId: ORG_A,
          status: "active",
          joinedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-0000000000b3",
          userId: OWNER_B,
          organizationId: ORG_B,
          status: "active",
          joinedAt: now,
        },
      ],
    });

    app = createPrismaClient(restrictedUrl());
    await app.$connect();
  }, 120_000);

  afterAll(async () => {
    await app.$disconnect();
    await admin.invitation.deleteMany({});
    await admin.organizationMembership.deleteMany({});
    await admin.organization.deleteMany({});
    await admin.user.deleteMany({});
    await admin.$disconnect();
  }, 60_000);

  it("returns nothing when no tenant context is set (fails closed)", async () => {
    // The critical property. A bug that forgets to establish tenant context
    // must yield *no* data, never *all* data. Application-level filtering has
    // the opposite failure mode: forget the WHERE and you get everything.
    const rows = await app.organizationMembership.findMany();

    expect(rows).toHaveLength(0);
  });

  it("shows only the current tenant's rows, even with no WHERE clause", async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`;
      return tx.organizationMembership.findMany();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(ORG_A);
  });

  it("hides another tenant's rows even when the query explicitly asks for them", async () => {
    // The scenario RLS exists for: application code with a deliberately
    // wrong filter, asking for a tenant it has no right to. Every
    // application-layer check has been bypassed here — and it still returns
    // nothing, because the database refuses independently of the query.
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`;
      return tx.organizationMembership.findMany({ where: { organizationId: ORG_B } });
    });

    expect(rows).toHaveLength(0);
  });

  it("scopes organizations to the tenant itself", async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`;
      return tx.organization.findMany();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ORG_A);
  });

  it("refuses a write attributed to another tenant (WITH CHECK)", async () => {
    // USING alone would allow this: the row would insert successfully and
    // then be invisible to its own author. Cross-tenant *writes* are as much
    // a breach as cross-tenant reads.
    const attempt = app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`;
      return tx.organizationMembership.create({
        data: {
          id: "00000000-0000-4000-8000-0000000000c1",
          userId: OWNER_A,
          organizationId: ORG_B,
          status: "active",
          joinedAt: new Date(),
        },
      });
    });

    await expect(attempt).rejects.toThrow();
  });

  it("does not leak tenant context onto a pooled connection between transactions", async () => {
    // The reason the setting is transaction-scoped rather than session-scoped.
    // If it persisted on the connection, this second query — with no context
    // of its own — would inherit tenant A's and return its rows. Under
    // connection pooling that leak lands on an unrelated request.
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`;
      return tx.organizationMembership.findMany();
    });

    const afterwards = await app.organizationMembership.findMany();

    expect(afterwards).toHaveLength(0);
  });

  it("still lets a user be seen across tenants, since users are not tenant-scoped", async () => {
    // `users` is intentionally outside RLS: a user is a global identity that
    // may belong to several organizations (ADR-0002). Scoping it would make
    // multi-org membership unrepresentable.
    const users = await app.user.findMany();

    expect(users.length).toBeGreaterThanOrEqual(2);
  });
});
