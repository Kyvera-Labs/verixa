import { DomainError, type Result } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";

export interface AuditLogFilters {
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly action?: string | undefined;
  readonly fromDate?: Date | undefined;
  readonly toDate?: Date | undefined;
}

export interface FindWithFiltersParams {
  readonly filters: AuditLogFilters;
  readonly fromSequence: number;
  readonly limit: number;
}

/**
 * Returned when another writer extended the chain first. Losing this compare-and-set race is
 * expected under load: re-read the head, relink and retry. `expected` is the head the writer
 * assumed and `actual` is the real head.
 */
export class ChainConflictError extends DomainError {
  readonly code = "AUDIT_CHAIN_CONFLICT";
  // 409: the request is well-formed and conflicts with current state, which is
  // precisely what "the chain moved underneath you" is.
  readonly httpStatusHint = 409;

  constructor(
    readonly expectedPreviousHash: string,
    readonly actualPreviousHash: string,
  ) {
    super(
      `Audit append expected the chain head to be ${expectedPreviousHash} but found ${actualPreviousHash}.`,
    );
  }
}

/**
 * Persistence for the audit log. Append-only: there is no update or delete, because a mutation
 * method would make the hash chain meaningless. Erasure will arrive as its own reviewed, auditable
 * operation.
 *
 * Every append carries `expectedPreviousHash` and the insert re-checks it, returning {@link
 * ChainConflictError} if the head moved. This prevents two entries claiming the same predecessor
 * and forking the chain.
 */
export interface AuditLogRepository {
  /**
   * The most recent entry, or `undefined` when the log is empty.
   *
   * Callers need this to append: a new entry commits to its predecessor's
   * hash, so writing one requires having read the tail. Note that the value
   * read here is a *proposal*, not a guarantee — the guarantee is the
   * `expectedPreviousHash` check inside `append`.
   */
  findLatest(): Promise<AuditLogEntry | undefined>;

  /**
   * Appends `entry` iff the chain still ends at `expectedPreviousHash`.
   *
   * The check and the insert must be one indivisible operation. Passing the
   * genesis hash appends to an empty chain, which is what makes a fresh
   * install and a raced append the same code path rather than two.
   */
  append(
    entry: AuditLogEntry,
    expectedPreviousHash: string,
  ): Promise<Result<void, ChainConflictError>>;

  /**
   * Appends `entries` atomically if the chain ends at `expectedPreviousHash`. A partial batch would
   * leave a gap in the chain, so it is all or nothing; checking the batch is internally linked is
   * the adapter's job.
   */
  appendMany(
    entries: readonly AuditLogEntry[],
    expectedPreviousHash: string,
  ): Promise<Result<void, ChainConflictError>>;

  /** Entries from `fromSequence` onward, in order. Used by verification. */
  findFrom(fromSequence: number, limit: number): Promise<readonly AuditLogEntry[]>;

  /** Queries entries with filters and cursor-based pagination. */
  findWithFilters(params: FindWithFiltersParams): Promise<readonly AuditLogEntry[]>;

  /** Total entries in the log. */
  count(): Promise<number>;
}

/** A commitment of the chain head to an external ledger. */
export interface AnchorRecord {
  readonly sequence: number;
  readonly chainHash: string;
  readonly anchorRef: string;
  readonly network: string;
  readonly anchoredAt: Date;
}

/** Persistence for anchoring receipts. */
export interface AnchorRecordRepository {
  save(record: AnchorRecord): Promise<void>;
  findLatest(): Promise<AnchorRecord | undefined>;
  findAll(limit: number): Promise<readonly AnchorRecord[]>;
}

/**
 * Anchoring capability this package needs. Structurally identical to `HashAnchor` in
 * `@verixa/stellar-anchor` but declared locally, so the audit package does not depend on a specific
 * ledger.
 */
export interface HashAnchorPort {
  anchor(
    hash: string,
  ): Promise<
    | { readonly kind: "ok"; readonly value: AnchorReceiptLike }
    | { readonly kind: "err"; readonly error: AnchorFailure }
  >;
}

/**
 * Read half of an anchoring ledger: confirms a commitment exists outside the operator's control.
 * Separate from {@link HashAnchorPort} because verification needs no credentials, only public
 * ledger data.
 */
export interface AnchorVerifierPort {
  verify(
    hash: string,
    anchorRef: string,
  ): Promise<
    | { readonly kind: "ok"; readonly value: boolean }
    | { readonly kind: "err"; readonly error: AnchorFailure }
  >;
}

/** The minimum an anchoring failure must carry. */
export interface AnchorFailure {
  readonly message: string;
}

/** The receipt shape {@link HashAnchorPort.anchor} resolves with. */
export interface AnchorReceiptLike {
  readonly hash: string;
  readonly anchorRef: string;
  readonly anchoredAt: Date;
  readonly network: string;
}
