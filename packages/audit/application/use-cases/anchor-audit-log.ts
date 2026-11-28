import { Result, ValidationError } from "@verixa/shared-kernel";

import type {
  AnchorFailure,
  AnchorRecord,
  AnchorRecordRepository,
  AuditLogRepository,
  HashAnchorPort,
} from "../ports/audit-log-repository.js";

export interface AnchorAuditLogResult {
  readonly record: AnchorRecord;
  /** Entries covered by this anchor that were not covered by the previous one. */
  readonly newlyCovered: number;
}

export type AnchorAuditLogError = ValidationError | AnchorFailure;

/**
 * Commits the audit log's current head hash to an external public ledger.
 *
 * The hash chain alone is only tamper-evident to someone holding an earlier hash: an attacker with
 * database access could rewrite the log and re-derive every hash. Once the head is on a public
 * ledger the operator does not control, anyone can verify the log independently.
 *
 * Only the digest is anchored, never content. Anchoring runs periodically rather than per entry,
 * because anchoring the head commits to every entry beneath it; the interval bounds the window for
 * undetected tampering.
 */
export class AnchorAuditLog {
  constructor(
    private readonly auditLog: AuditLogRepository,
    private readonly anchors: AnchorRecordRepository,
    private readonly hashAnchor: HashAnchorPort,
  ) {}

  async execute(): Promise<Result<AnchorAuditLogResult, AnchorAuditLogError>> {
    const head = await this.auditLog.findLatest();
    if (head === undefined) {
      return Result.err(
        new ValidationError("There is nothing to anchor: the audit log is empty.", {
          auditLog: ["empty"],
        }),
      );
    }

    const previous = await this.anchors.findLatest();
    if (previous !== undefined && previous.chainHash === head.hash) {
      // Nothing has been logged since the last anchor. Submitting the same
      // hash again would spend a fee to record a fact already on-chain.
      return Result.err(
        new ValidationError("The current chain head is already anchored.", {
          auditLog: ["already_anchored"],
        }),
      );
    }

    const receipt = await this.hashAnchor.anchor(head.hash);
    if (Result.isErr(receipt)) {
      // Returned rather than thrown: a scheduled anchor that cannot reach the
      // network should log and retry on the next tick, not crash the process.
      return receipt;
    }

    const record: AnchorRecord = {
      sequence: head.sequence,
      chainHash: head.hash,
      anchorRef: receipt.value.anchorRef,
      network: receipt.value.network,
      anchoredAt: receipt.value.anchoredAt,
    };

    // Persisted *after* the ledger accepted it. The reverse order would let a
    // crash between the two leave a record claiming an anchor that does not
    // exist — a false proof, which is worse than a missing one.
    await this.anchors.save(record);

    return Result.ok({
      record,
      newlyCovered: head.sequence - (previous?.sequence ?? 0),
    });
  }
}
