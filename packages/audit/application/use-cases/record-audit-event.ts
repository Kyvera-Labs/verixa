import { Result } from "@verixa/shared-kernel";

import type { AuditAction, AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import { AuditLogEntry as Entry, GENESIS_HASH } from "../../domain/entities/audit-log-entry.js";
import { AuditMetadata, rejectionReasonOf } from "../../domain/value-objects/audit-metadata.js";
import type { AuditLogRepository } from "../ports/audit-log-repository.js";

export interface RecordAuditEventCommand {
  readonly action: AuditAction;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Fixed timestamp, for callers recording an event that already happened. */
  readonly occurredAt?: Date | undefined;
}

/** Default ceiling on compare-and-set retries per `execute` call. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Records an audit entry for a domain event that already happened. A port so routes do not depend
 * on whether the synchronous writer or the batched writer is wired.
 *
 * `execute` resolves with the written entry, or `undefined` if nothing was written (write failure,
 * lost race or full queue). It must never reject: the audited operation already succeeded. Use the
 * writer's failure and overflow reports to tell the cases apart.
 */
export interface AuditRecorder {
  execute(command: RecordAuditEventCommand): Promise<AuditLogEntry | undefined>;
}

/**
 * Appends one entry to the audit log. Failures are logged and swallowed, never thrown, so a failed
 * audit write does not fail the operation being audited. The resulting gap is detectable by
 * `verifyChain` and by the anchored head.
 *
 * Appends race on a unique `sequence`; a `ChainConflictError` is retried by re-reading the head and
 * relinking, up to a fixed limit.
 *
 * Metadata bounds (field count, key and value length, string values) are enforced here because they
 * cannot be applied later. Escaping happens only on output, so the digest commits to exactly what
 * was supplied. When bounds are exceeded the entry is still written, with the metadata replaced by
 * a marker naming the reason.
 */
export class RecordAuditEvent implements AuditRecorder {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {}

  async execute(command: RecordAuditEventCommand): Promise<AuditLogEntry | undefined> {
    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        const previous = await this.repository.findLatest();
        const expectedPreviousHash = previous?.hash ?? GENESIS_HASH;

        const entry = Entry.append({
          action: command.action,
          actorId: command.actorId,
          subjectId: command.subjectId,
          metadata: metadataFor(command),
          occurredAt: command.occurredAt,
          previous,
        });

        const outcome = await this.repository.append(entry, expectedPreviousHash);
        if (Result.isOk(outcome)) {
          return entry;
        }

        // Lost the race. Loop re-reads the head, so the next attempt links
        // onto whatever the winning writer put there.
      }
      this.onError(
        new Error(
          `Audit append lost ${String(this.maxAttempts)} consecutive chain races and was abandoned.`,
        ),
      );
      return undefined;
    } catch (error) {
      // Never propagates. See the class comment: the audited operation
      // already happened, and failing it now would be reporting a false
      // negative to the user.
      this.onError(error);
      return undefined;
    }
  }
}

/**
 * Records a burst of events as one atomic chain extension, linked in the given order: one
 * transaction, and an ordering that cannot be partially applied.
 */
export async function recordAuditEventBatch(
  repository: AuditLogRepository,
  commands: readonly RecordAuditEventCommand[],
  onError: (error: unknown) => void = () => undefined,
): Promise<readonly AuditLogEntry[]> {
  if (commands.length === 0) {
    return [];
  }

  try {
    const previous = await repository.findLatest();
    // The hash of the head *before* this batch — that is what `appendMany`
    // compare-and-sets against. The entries' own links are checked by the
    // repository walking the batch, not by this argument.
    const expectedPreviousHash = previous?.hash ?? GENESIS_HASH;

    let tail = previous;
    const entries: AuditLogEntry[] = [];
    for (const command of commands) {
      const entry = Entry.append({
        action: command.action,
        actorId: command.actorId,
        subjectId: command.subjectId,
        metadata: command.metadata ?? {},
        occurredAt: command.occurredAt,
        previous: tail,
      });
      entries.push(entry);
      tail = entry;
    }

    const outcome = await repository.appendMany(entries, expectedPreviousHash);
    if (Result.isErr(outcome)) {
      onError(outcome.error);
      return [];
    }

    return entries;
  } catch (error) {
    onError(error);
    return [];
  }
}

function metadataFor(command: RecordAuditEventCommand): Readonly<Record<string, string>> {
  const created = AuditMetadata.create(command.metadata ?? {});

  if (Result.isOk(created)) return created.value.values;

  return AuditMetadata.rejected(rejectionReasonOf(created.error)).values;
}
