// Re-exports the generated Prisma client as this package's public surface, so
// consumers import `@verixa/database` rather than `@prisma/client` directly.
// That indirection is what lets the ORM choice stay an infrastructure detail:
// only this package and the repository adapters that implement Phase 02's
// ports ever see Prisma types, and the domain/application layers never do.
//
// The client is generated, not committed — it is derived from the schema (and
// bundles the query compiler for it), so `pnpm db:generate` must run after a
// fresh clone and any time the schema changes. See docs/guides/database.md.
// Loaded through createRequire rather than a static `export ... from`.
//
// The generated Prisma client is CommonJS, and Node's ESM loader can only
// statically analyse named exports from CJS when they are assigned in a form
// its lexer recognises. Prisma builds its exports dynamically, so the lexer
// finds nothing and `export { PrismaClient } from "@prisma/client"` throws at
// import time with "Named export not found".
//
// This never surfaced in tests — Vitest transforms modules rather than using
// Node's ESM loader — nor in `pnpm build`, since it is purely a runtime
// resolution concern. It appeared the moment a real `node dist/server.js`
// imported this package, which is why wiring the composition root into the
// server was worth doing on its own.
import { createRequire } from "node:module";

// Ships a real ESM build (unlike the generated client), so a static import works.
import { PrismaPg } from "@prisma/adapter-pg";

const require = createRequire(import.meta.url);
const prismaRuntime = require("@prisma/client") as typeof import("@prisma/client");

export const {
  InvitationStatus,
  MembershipStatus,
  OrganizationStatus,
  PolicyLifecycleStatus,
  Prisma,
  PrismaClient,
  UserStatus,
  VerificationDecision,
  VerificationStatus,
  VerificationType,
} = prismaRuntime;

// The destructuring above binds values only, and several of these names are
// needed in type position too — `PrismaClient` as a constructor parameter on
// every repository adapter, the enums as the `status` field of four domain
// entities. A `const` and a `type` may share a name (they live in separate
// declaration spaces), so each is declared twice rather than re-exported;
// `export type { PrismaClient } from "@prisma/client"` would collide with the
// value binding instead of complementing it.
export type PrismaClient = InstanceType<typeof prismaRuntime.PrismaClient>;
export type PrismaInputJsonValue = import("@prisma/client").Prisma.InputJsonValue;
export type InvitationStatus =
  (typeof prismaRuntime.InvitationStatus)[keyof typeof prismaRuntime.InvitationStatus];
export type MembershipStatus =
  (typeof prismaRuntime.MembershipStatus)[keyof typeof prismaRuntime.MembershipStatus];
export type OrganizationStatus =
  (typeof prismaRuntime.OrganizationStatus)[keyof typeof prismaRuntime.OrganizationStatus];
export type PolicyLifecycleStatus =
  (typeof prismaRuntime.PolicyLifecycleStatus)[keyof typeof prismaRuntime.PolicyLifecycleStatus];
export type UserStatus = (typeof prismaRuntime.UserStatus)[keyof typeof prismaRuntime.UserStatus];
export type VerificationDecision =
  (typeof prismaRuntime.VerificationDecision)[keyof typeof prismaRuntime.VerificationDecision];
export type VerificationStatus =
  (typeof prismaRuntime.VerificationStatus)[keyof typeof prismaRuntime.VerificationStatus];
export type VerificationType =
  (typeof prismaRuntime.VerificationType)[keyof typeof prismaRuntime.VerificationType];

// Surfaced directly rather than left behind `Prisma.` — adapters need to
// recognise it to translate constraint violations into domain errors, and a
// `const Prisma` carries no namespace meaning for the type position. Lifting
// it here also suits this package's purpose better: callers should not be
// reaching through a Prisma namespace to name an error they must handle.
export const PrismaClientKnownRequestError = prismaRuntime.Prisma.PrismaClientKnownRequestError;
export type PrismaClientKnownRequestError = InstanceType<
  typeof prismaRuntime.Prisma.PrismaClientKnownRequestError
>;

/** Pool settings applied when the connection string does not set its own. */
export interface PoolDefaults {
  /** Most connections this process holds open (`DATABASE_POOL_SIZE`). */
  readonly poolSize?: number;
  /** Seconds to wait for a free connection; 0 waits forever. */
  readonly poolTimeoutSeconds?: number;
}

/** The subset of node-postgres's PoolConfig that createPrismaClient sets. */
export interface PgPoolConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
}

/**
 * Translates a connection string into node-postgres pool settings.
 *
 * Prisma 6's query engine read `connection_limit` and `pool_timeout` from the
 * URL. Since Prisma 7 the client connects through node-postgres (the pg
 * driver adapter), which neither understands those parameters nor reads pool
 * size from the URL at all. So they are lifted out of the URL here and mapped
 * to `max` and `connectionTimeoutMillis`. As before, values written in the URL
 * win over `defaults`, so a deployment can still override per environment.
 */
export function pgPoolConfig(connectionString: string, defaults: PoolDefaults = {}): PgPoolConfig {
  const url = new URL(connectionString);
  const limit = takeIntegerParam(url, "connection_limit", 1) ?? defaults.poolSize;
  const timeout = takeIntegerParam(url, "pool_timeout", 0) ?? defaults.poolTimeoutSeconds;
  const rewritten = url.searchParams.size !== new URL(connectionString).searchParams.size;
  return {
    // Untouched unless a parameter was removed, so a URL with unusual
    // escaping is never re-serialised needlessly.
    connectionString: rewritten ? url.toString() : connectionString,
    ...(limit !== undefined && { max: limit }),
    ...(timeout !== undefined && { connectionTimeoutMillis: timeout * 1000 }),
  };
}

function takeIntegerParam(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  url.searchParams.delete(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} in the database URL must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/**
 * Builds a PrismaClient connected to `connectionString`.
 *
 * Prisma 7 removed the `datasources` constructor option; a client now needs a
 * driver adapter. Every client in this repo is built here so that the adapter
 * and the pool translation above live in one place.
 */
export function createPrismaClient(
  connectionString: string,
  pool: PoolDefaults = {},
): PrismaClient {
  return new prismaRuntime.PrismaClient({
    adapter: new PrismaPg(pgPoolConfig(connectionString, pool)),
  });
}

// Row types for the models defined in prisma/schema.prisma. Repository
// adapters (Issue 046 onward) map between these and the domain entities;
// nothing outside an adapter should ever hold one.
export type {
  Credential as CredentialRow,
  Invitation as InvitationRow,
  Organization as OrganizationRow,
  OrganizationMembership as OrganizationMembershipRow,
  Policy as PolicyRow,
  Session as SessionRow,
  User as UserRow,
  MfaMethod as MfaMethodRow,
  VerificationRequest as VerificationRequestRow,
} from "@prisma/client";
