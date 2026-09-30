// Curated public surface of @verixa/audit. Nothing outside this package should
// import from a deep path (`@verixa/audit/domain/...`,
// `@verixa/audit/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.
//
// What is deliberately *not* here: the hash chain's mechanics. `GENESIS_HASH`,
// the canonical serialization, and `AuditLogEntry`'s factories (`append`,
// `reconstitute`) stay internal. A consumer that could mint an entry could
// append one without going through `RecordAuditEvent`, which is the one place
// that reads the chain tail before linking to it — and the chain is only as
// trustworthy as its least careful writer. Consumers can read entries and
// verify a chain; they cannot build one.

// Domain: the entry as a read-only type, and the chain-verification tool
export type {
  AuditAction,
  AuditLogEntry,
  AuditLogEntryId,
  ChainBreak,
} from "./domain/entities/audit-log-entry.js";
export { verifyChain } from "./domain/entities/audit-log-entry.js";

// Application: ports (for the composition root to supply adapters for)
export type {
  AnchorFailure,
  AnchorReceiptLike,
  AnchorRecord,
  AnchorRecordRepository,
  AuditLogRepository,
  HashAnchorPort,
} from "./application/ports/audit-log-repository.js";

// Application: use cases
export {
  AnchorAuditLog,
  type AnchorAuditLogError,
  type AnchorAuditLogResult,
} from "./application/use-cases/anchor-audit-log.js";
export {
  RecordAuditEvent,
  type RecordAuditEventCommand,
} from "./application/use-cases/record-audit-event.js";

// Infrastructure: Prisma-backed adapters. Exported so the composition root
// (apps/api) can construct them — it is the one place allowed to know which
// concrete implementation is in use. The row mapper they use is internal.
export {
  PrismaAnchorRecordRepository,
  PrismaAuditLogRepository,
} from "./infrastructure/persistence/prisma-audit-repositories.js";

// Testing fakes. Exported so contexts that record audit events can test their
// own use cases against the same fake, rather than each writing one that
// drifts from the append-only contract.
export {
  InMemoryAnchorRecordRepository,
  InMemoryAuditLogRepository,
} from "./infrastructure/testing/in-memory-audit-repositories.js";
