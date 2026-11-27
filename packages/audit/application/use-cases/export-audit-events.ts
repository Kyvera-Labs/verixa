import { Result } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditReader } from "../../domain/policies/audit-access-policy.js";
import { type AuditReadError, authorizeAndRecordAuditRead } from "../audit-read-access.js";
import type { AuditEventReader } from "../ports/audit-event-reader.js";

import type { RecordAuditEvent } from "./record-audit-event.js";

export interface ExportAuditEventsCommand {
  /** The authenticated caller, built by the interface layer — see {@link AuditReader}. */
  readonly reader: AuditReader;
  /** Whose audit log to export. Must be the reader's own organization. */
  readonly organizationId: string;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/**
 * Streams every matching entry of an organization's audit log for a compliance export and records
 * the export. Requires `audit:export`, which is separate from `audit:query`.
 *
 * The `audit.exported` entry is written before the stream starts, so an export abandoned partway is
 * still recorded. Encoding is left to the interface layer.
 */
export class ExportAuditEvents {
  constructor(
    private readonly events: AuditEventReader,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    command: ExportAuditEventsCommand,
  ): Promise<Result<AsyncIterable<AuditLogEntry>, AuditReadError>> {
    const criteria = {
      organizationId: command.organizationId,
      actorId: command.actorId,
      subjectId: command.subjectId,
      from: command.from,
      to: command.to,
    };

    const access = await authorizeAndRecordAuditRead(
      this.recordAuditEvent,
      command.reader,
      "export",
      criteria,
    );
    if (Result.isErr(access)) return access;

    return Result.ok(this.events.stream(criteria));
  }
}
