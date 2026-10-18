import { type OrganizationId, withTenantContext } from "@verixa/identity";
import { asId, TENANT_CONTEXT_SETTING } from "@verixa/shared-kernel";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Adversarial input against the one raw-query call site in shipped code
 * (Issue 210).
 *
 * `withTenantContext` builds `SELECT set_config($1, $2, true)` from a Prisma
 * tagged template, which is the safe form — but "safe" is a claim about how the
 * driver serializes the statement, and the only way to *know* it is to hand it
 * something that would do damage if it were ever pasted into SQL text instead
 * of bound beside it.
 *
 * The unit version of this (`packages/identity/infrastructure/persistence/
 * prisma-tenant-context.spec.ts`) asserts the `{ text, values }` split. This
 * asserts what Postgres actually did with it, which is the assertion that would
 * survive someone changing the ORM as well as the query.
 */

const available = await databaseAvailability();

const PRISTINE_TENANT = "00000000-0000-4000-8000-0000000000a1";

/**
 * These payloads are not organization ids. Wrapping them is a lie the type
 * system lets us tell, and the point of the test is that the value is
 * *whatever the caller handed over* — so the lie is the honest part: this is
 * what an adapter receives when a caller has been handed a hostile string and
 * passed it through.
 */
function tenant(value: string): OrganizationId {
  return asId(value);
}

describe.skipIf(!available)("injection hardening", () => {
  const prisma = createTestPrismaClient();

  let usersBefore = 0;

  beforeAll(async () => {
    usersBefore = await prisma.user.count();
  });

  it("stores a SQL-smuggling payload as data, verbatim", async () => {
    // If the tenant id were concatenated, this statement would not be
    // `SELECT set_config($1, $2, true)` any more — it would be two statements,
    // or a syntax error. Either way it would not come back equal to the input,
    // and that is what makes this the load-bearing assertion: reading the
    // setting back is the database itself confirming it treated the payload as
    // a value.
    const payload = `${PRISTINE_TENANT}'; SELECT 'injected`;

    const rows = await withTenantContext(prisma, tenant(payload), (tx) =>
      tx.$queryRaw<{ value: string }[]>`SELECT current_setting(${TENANT_CONTEXT_SETTING}) AS value`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(payload);
  });

  it("does not let a payload close the statement and run a second one", async () => {
    const payload = `${PRISTINE_TENANT}', true); DROP TABLE users; --`;

    await withTenantContext(prisma, tenant(payload), (tx) =>
      tx.$queryRaw<{ value: string }[]>`SELECT current_setting(${TENANT_CONTEXT_SETTING}) AS value`,
    );

    // `users` is still there, still populated. A concatenated value would have
    // made this the moment the schema disappeared.
    await expect(prisma.user.count()).resolves.toBe(usersBefore);
  });

  it("fails closed when the tenant id is not a uuid", async () => {
    // RLS policies read the setting and cast it with `::uuid`. A value that is
    // not a uuid must therefore abort the query rather than be silently
    // compared as text — the difference between "no rows" and "every row".
    const payload = `${PRISTINE_TENANT} OR 1=1 --`;

    await expect(
      withTenantContext(prisma, tenant(payload), (tx) =>
        tx.$queryRaw`SELECT current_setting(${TENANT_CONTEXT_SETTING})::uuid AS id`,
      ),
    ).rejects.toThrow(/uuid/i);
  });

  it("leaves the tenant context unset for the next transaction", async () => {
    // `set_config(..., true)` is transaction-local. If it were session-scoped,
    // the id above would still be bound when this pooled connection is handed
    // to unrelated work — the failure mode that turns one request's tenant into
    // another's.
    const rows = await prisma.$queryRaw<{ value: string | null }[]>`
      SELECT current_setting(${TENANT_CONTEXT_SETTING}, true) AS value
    `;

    // `true` as the second argument asks for NULL instead of an error when the
    // setting has never been touched on this session.
    expect(rows[0]?.value === null || rows[0]?.value === "").toBe(true);
  });
});
