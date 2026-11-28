import type { AuditLogEntry } from "../domain/entities/audit-log-entry.js";
import {
  escapeJsonLineTerminators,
  neutralizeFormulaPrefix,
} from "../domain/value-objects/audit-metadata.js";

/**
 * Renders an audit export. Kept separate from `ExportAuditEvents`, which authorizes, records and
 * yields entries but never serializes, so the encoder can be tested on its own.
 */

/**
 * Export format.
 *
 * `jsonl` is the faithful format: one JSON document per line, values as recorded. Use it for
 * programs, re-verification and archives.
 *
 * `csv` is opened in spreadsheets that execute cell contents, so the writer escapes control
 * characters, quotes cells containing delimiters, and neutralizes formula prefixes. All three are
 * required.
 */
export type AuditExportFormat = "csv" | "jsonl";

/** The columns of a CSV export, in order. */
export const AUDIT_EXPORT_HEADER =
  "sequence,action,actor_id,subject_id,occurred_at,previous_hash,hash,metadata";

/**
 * How many entries one export may produce.
 *
 * An export of an unbounded log is a memory-exhaustion request with an
 * authorization header on it, so the cap is explicit and `truncated` says when
 * it applied. Silently returning a partial file would be worse than the outage:
 * an auditor counting rows would have no way to know the count was a limit
 * rather than a fact.
 */
export const DEFAULT_EXPORT_MAX_RECORDS = 10_000;

export interface ExportAuditEventsResult {
  readonly format: AuditExportFormat;
  readonly body: string;
  readonly recordCount: number;
  readonly truncated: boolean;
}

/**
 * The logging capability an export needs, declared as the minimum shape.
 *
 * pino's `Logger` satisfies this structurally. The use case takes a port
 * rather than importing pino so the domain and application layers stay free of
 * the logging implementation, and so a test can capture what would have been
 * written.
 */
export interface AuditExportLogger {
  info(fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

/**
 * Encodes entries into one export body, stopping at `maxRecords`.
 *
 * Takes an `AsyncIterable` so it composes with what `ExportAuditEvents` yields
 * and never holds more than it must: it stops reading as soon as the cap is
 * reached, rather than draining the log and discarding the surplus.
 */
export async function encodeAuditExport(
  entries: AsyncIterable<AuditLogEntry>,
  options: {
    readonly format: AuditExportFormat;
    readonly maxRecords?: number | undefined;
    readonly logger?: AuditExportLogger | undefined;
    /** Recorded with the export, as one escaped JSON field. */
    readonly logContext?: Readonly<Record<string, unknown>> | undefined;
  },
): Promise<ExportAuditEventsResult> {
  const maxRecords = options.maxRecords ?? DEFAULT_EXPORT_MAX_RECORDS;
  const rows: string[] = [];
  let truncated = false;

  for await (const entry of entries) {
    if (rows.length >= maxRecords) {
      truncated = true;
      break;
    }
    rows.push(options.format === "csv" ? csvRow(entry) : jsonlRow(entry));
  }

  const body =
    options.format === "csv"
      ? `${AUDIT_EXPORT_HEADER}\r\n${rows.map((row) => `${row}\r\n`).join("")}`
      : rows.map((row) => `${row}\n`).join("");

  logExport(options.logger, options.format, rows.length, truncated, options.logContext ?? {});

  return { format: options.format, body, recordCount: rows.length, truncated };
}

/**
 * Logs that an export happened. The caller-supplied context goes in a JSON field with line
 * terminators escaped, never in the message, so a newline in a value cannot forge a log line.
 */
function logExport(
  logger: AuditExportLogger | undefined,
  format: AuditExportFormat,
  recordCount: number,
  truncated: boolean,
  logContext: Readonly<Record<string, unknown>>,
): void {
  logger?.info({
    type: "audit.log.exported",
    format,
    recordCount,
    truncated,
    context: escapeJsonLineTerminators(JSON.stringify(logContext) ?? "{}"),
  });
}

/** A CSV row: every field escaped by the entry, quoted and neutralized here. */
function csvRow(entry: AuditLogEntry): string {
  const fields = entry.toLogFields();

  return [
    fields.sequence,
    fields.action,
    fields.actorId,
    fields.subjectId,
    fields.occurredAt,
    fields.previousHash,
    fields.hash,
    fields.metadata,
  ]
    .map((field) => csvCell(field ?? ""))
    .join(",");
}

/**
 * Encodes one CSV cell: RFC 4180 quoting, then formula neutralization. Neutralizing after escaping
 * means a formula character hidden behind a tab is already rendered as the text `\t`.
 */
function csvCell(value: string): string {
  const neutralized = neutralizeFormulaPrefix(value);

  return /[",\r\n]/u.test(neutralized) ? `"${neutralized.replace(/"/gu, '""')}"` : neutralized;
}

/**
 * Encodes one entry as a JSON document.
 *
 * Values go out verbatim: JSON's own escapes cover the characters that would
 * break the line structure, and an audit export that silently rewrites what was
 * recorded is worth less than one that cannot be opened.
 */
function jsonlRow(entry: AuditLogEntry): string {
  return JSON.stringify({
    sequence: entry.sequence,
    action: entry.action,
    actorId: entry.actorId ?? null,
    subjectId: entry.subjectId ?? null,
    occurredAt: entry.occurredAt.toISOString(),
    previousHash: entry.previousHash,
    hash: entry.hash,
    metadata: { ...entry.metadata },
  });
}
