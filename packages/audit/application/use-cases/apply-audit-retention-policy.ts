import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditLogRepository } from "../ports/audit-log-repository.js";
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from "../ports/retention-policy.js";

export interface ApplyRetentionPolicyCommand {
  /** Pin the evaluation instant; defaults to now. Tests pin it. */
  readonly now?: Date | undefined;
  /** Resume from a previous review's `nextCursor`. */
  readonly cursor?: number | undefined;
  /** Entries examined per run. */
  readonly limit?: number | undefined;
  /** Restrict the review to one tenant. */
  readonly organizationId?: string | undefined;
}

/** An entry the policy says is past retention — and nothing has been done about it. */
export interface RetentionCandidate {
  readonly entry: AuditLogEntry;
  /** How old the entry was at evaluation, in whole days. */
  readonly ageDays: number;
}

/**
 * What a retention run produced.
 *
 * `disposition` is a literal field rather than implied by the absence of
 * deletion, and it is here so that a caller logging this result has something
 * to assert on. A review whose output reads like an action report is how an
 * identify-only job gets mistaken for an erasing one.
 */
export interface RetentionReview {
  readonly policy: string;
  readonly evaluatedAt: Date;
  readonly cutoff: Date;
  readonly candidates: readonly RetentionCandidate[];
  /** Sequence of the last entry examined, for resuming. */
  readonly evaluatedThroughSequence: number | undefined;
  readonly nextCursor: number | undefined;
  readonly hasMore: boolean;
  readonly disposition: "identified_only";
}

const MS_PER_DAY = 86_400_000;

/**
 * Identifies audit entries older than the retention window. It deliberately deletes nothing:
 * erasure is a compliance decision handled separately, and reporting candidates first lets
 * operators see their backlog safely.
 *
 * Candidates are reported rather than archived, because moving content away from its hashes would
 * make verification report `content_altered`. The walk uses a keyset cursor so long runs can
 * resume.
 */
export class ApplyAuditRetentionPolicy {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  ) {}

  async execute(command: ApplyRetentionPolicyCommand = {}): Promise<RetentionReview> {
    const now = command.now ?? new Date();
    const cutoff = this.policy.cutoffDate(now);
    const limit = command.limit ?? 200;
    const cursor = command.cursor ?? 0;

    // `toDate` is the retention boundary itself: this is a scan for age, and
    // the repository filter is what keeps it off the recent half of the log.
    const entries = await this.repository.findWithFilters({
      filters: {
        toDate: cutoff,
        organizationId: command.organizationId,
      },
      fromSequence: cursor + 1,
      // One extra, to know whether there is more without a second query.
      limit: limit + 1,
    });

    const hasMore = entries.length > limit;
    const examined = hasMore ? entries.slice(0, limit) : entries;

    const candidates = examined.map((entry) => ({
      entry,
      ageDays: Math.floor((now.getTime() - entry.occurredAt.getTime()) / MS_PER_DAY),
    }));

    return {
      policy: this.policy.name,
      evaluatedAt: now,
      cutoff,
      candidates,
      evaluatedThroughSequence: examined.at(-1)?.sequence,
      nextCursor:
        hasMore && examined.length > 0 ? examined[examined.length - 1]!.sequence : undefined,
      hasMore,
      disposition: "identified_only",
    };
  }
}
