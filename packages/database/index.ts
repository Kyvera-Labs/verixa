// Re-exports the generated Prisma client as this package's public surface, so
// consumers import `@verixa/database` rather than `@prisma/client` directly.
// That indirection is what lets the ORM choice stay an infrastructure detail:
// only this package and the repository adapters that implement Phase 02's
// ports ever see Prisma types, and the domain/application layers never do.
//
// The client is generated, not committed — it's platform-specific (it ships a
// compiled query-engine binary for the machine that generated it), so
// `pnpm db:generate` must run after a fresh clone and any time the schema
// changes. See docs/guides/database.md.
export { Prisma, PrismaClient, UserStatus } from "@prisma/client";

// Row types for the models defined in prisma/schema.prisma. Repository
// adapters (Issue 046 onward) map between these and the domain entities;
// nothing outside an adapter should ever hold one.
export type { User as UserRow } from "@prisma/client";
