import { Prisma, type PrismaClient } from "@verixa/database";
import { asId, TENANT_CONTEXT_SETTING } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { OrganizationId } from "../../domain/entities/organization.js";

import { withTenantContext } from "./prisma-tenant-context.js";

/**
 * The injection surface of the tenant context (Issue 210).
 *
 * `withTenantContext` is the one place in the codebase where a value from a
 * request ends up inside a SQL statement, and it is the place where a mistake
 * is worst: `SET` cannot take bind parameters, so the tempting version of this
 * code concatenated the organization id into the statement text. That would
 * hand anyone who controls a tenant id the ability to say something to
 * Postgres *as the application role*, on every query that follows.
 *
 * So these tests do not check that the payload is harmless — they check that
 * it never reaches the statement at all. The assertion that would fail if
 * someone refactored to concatenation is the one about the SQL *text* being
 * fixed, with the payload arriving only as a bound value.
 *
 * No database here on purpose: this is about how the statement is built, and a
 * unit test is the only version that runs on a machine without Postgres, which
 * is where the refactor would happen.
 */

/**
 * Payloads that are dangerous only if they are parsed as SQL. Each is a valid
 * non-empty string, so `assertValidTenantId` lets it through and the statement
 * has to be what stops it.
 */
const HOSTILE_IDS = [
  "1'; DROP TABLE users; --",
  "1' OR '1'='1",
  "' UNION SELECT password_hash FROM credentials --",
  "abc'); SELECT set_config('app.current_organization_id', 'attacker', false); --",
  "$$; TRUNCATE users; $$",
  "\\'; DROP TABLE users; \\--",
  "1' ; COPY users TO '/tmp/exfil' ; --",
] as const;

interface CapturedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A Prisma client that records instead of connecting.
 *
 * `$transaction` is stubbed to run its callback immediately, and the
 * transaction client's `$executeRaw` renders whatever it is handed with
 * Prisma's own template function — so the test asserts against the same
 * `{ text, values }` split the driver would send, rather than a reconstruction
 * of it. That is the whole point: the payload must be in `values` and nowhere
 * in `text`.
 */
function capturingClient(): { prisma: PrismaClient; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];

  const tx = {
    $executeRaw: (...args: unknown[]): Promise<number> => {
      const [strings, ...values] = args as [TemplateStringsArray, ...string[]];
      const query = Prisma.sql(strings, ...values);
      queries.push({ text: query.text, values: [...query.values] });
      return Promise.resolve(1);
    },
  };

  const prisma = {
    $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { prisma, queries };
}

function organizationId(value: string): OrganizationId {
  return asId(value);
}

describe("withTenantContext", () => {
  it("binds the tenant id instead of writing it into the statement", async () => {
    const { prisma, queries } = capturingClient();
    const id = organizationId("00000000-0000-4000-8000-0000000000a1");

    await withTenantContext(prisma, id, () => Promise.resolve("done"));

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toBe("SELECT set_config($1, $2, true)");
    expect(queries[0]?.values).toEqual([TENANT_CONTEXT_SETTING, id.toString()]);
  });

  it("runs the work inside the transaction it bound the context in", async () => {
    const { prisma } = capturingClient();

    const result = await withTenantContext(prisma, organizationId("org-1"), () =>
      Promise.resolve(42),
    );

    expect(result).toBe(42);
  });

  describe.each(HOSTILE_IDS.map((id) => [id]))("hostile organization id %s", (payload) => {
    it("keeps the payload out of the SQL text", async () => {
      const { prisma, queries } = capturingClient();

      await withTenantContext(prisma, organizationId(payload), () => Promise.resolve(undefined));

      const [query] = queries;
      expect(query).toBeDefined();
      // The statement is the same fixed text it always is, whatever the id.
      expect(query?.text).toBe("SELECT set_config($1, $2, true)");
      expect(query?.text).not.toContain(payload);
      // And nothing else was sent: one statement, one call, whatever the
      // payload tried to append.
      expect(queries).toHaveLength(1);
    });

    it("carries the payload only as a bound value, verbatim", async () => {
      const { prisma, queries } = capturingClient();

      await withTenantContext(prisma, organizationId(payload), () => Promise.resolve(undefined));

      // `values` is what Postgres receives after the statement is prepared, so
      // a payload here is data being stored in a GUC — not syntax being parsed.
      expect(queries[0]?.values).toEqual([TENANT_CONTEXT_SETTING, payload]);
    });
  });

  it("refuses an empty organization id before building any statement", async () => {
    const { prisma, queries } = capturingClient();

    await expect(
      withTenantContext(prisma, organizationId("   "), () => Promise.resolve(undefined)),
    ).rejects.toThrow(/non-empty organization id/);

    // The guard fires first, so there is no statement to inspect at all. An
    // empty setting would read back as `''` and RLS would answer "no rows" —
    // a wrong-but-plausible result rather than an error.
    expect(queries).toHaveLength(0);
  });
});
