// Curated public surface of @verixa/audit. Deep imports are blocked by the
// boundary rule in eslint.config.mjs — see docs/guides/domain-modeling.md.

// Domain
export {
  type AuditAction,
  AuditLogEntry,
  type AuditLogEntryId,
  type ChainBreak,
  GENESIS_HASH,
  verifyChain,
} from "./domain/entities/audit-log-entry.js";
export {
  AUDIT_PERMISSIONS,
  AuditAccessDeniedError,
  type AuditReader,
  type AuditReadOperation,
} from "./domain/policies/audit-access-policy.js";

// Application: ports
export type {
  AnchorFailure,
  AnchorReceiptLike,
  AnchorRecord,
  AnchorRecordRepository,
  AuditLogRepository,
  HashAnchorPort,
} from "./application/ports/audit-log-repository.js";
export type {
  AuditEventCriteria,
  AuditEventPage,
  AuditEventReader,
} from "./application/ports/audit-event-reader.js";

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
export {
  MAX_AUDIT_QUERY_PAGE_SIZE,
  QueryAuditEvents,
  type QueryAuditEventsCommand,
} from "./application/use-cases/query-audit-events.js";
export {
  ExportAuditEvents,
  type ExportAuditEventsCommand,
} from "./application/use-cases/export-audit-events.js";
export { type AuditReadError, AuditReadNotRecordedError } from "./application/audit-read-access.js";

// Infrastructure
export {
  AuditLogEntryMapper,
  PrismaAnchorRecordRepository,
  PrismaAuditLogRepository,
} from "./infrastructure/persistence/prisma-audit-repositories.js";
export {
  InMemoryAnchorRecordRepository,
  InMemoryAuditEventReader,
  InMemoryAuditLogRepository,
} from "./infrastructure/testing/in-memory-audit-repositories.js";
