// Chain primitives for test suites that must build entries by hand, such as the integration suite
// forging a forked entry and the load benchmark. Kept out of `index.ts` so production code cannot
// bypass `RecordAuditEvent`. Never import this from shipped code.
export { AuditLogEntry, GENESIS_HASH } from "./domain/entities/audit-log-entry.js";
export { AuditLogEntryMapper } from "./infrastructure/persistence/prisma-audit-repositories.js";
