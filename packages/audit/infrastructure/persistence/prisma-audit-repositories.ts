import { asId, Result } from "@verixa/shared-kernel";

import type {
  AnchorRecord,
  AnchorRecordRepository,
  AuditLogRepository,
  FindWithFiltersParams,
} from "../../application/ports/audit-log-repository.js";
import { ChainConflictError } from "../../application/ports/audit-log-repository.js";
import {
  type AuditAction,
  AuditLogEntry,
  GENESIS_HASH,
} from "../../domain/entities/audit-log-entry.js";

/**
 * What comes *out* of the database.
 *
 * `metadata` is `unknown` because a `Json` column can hold anything — the
 * shape is a convention this code maintains, not one Postgres enforces.
 * Treating it as already-correct on read is how a hand-edited row becomes a
 * crash inside the verification routine, at the exact moment verification is
 * what you are relying on.
 */
interface AuditRow {
  id: string;
  sequence: number;
  action: string;
  actorId: string | null;
  subjectId: string | null;
  metadata: unknown;
  occurredAt: Date;
  previousHash: string;
  hash: string;
}

/**
 * What goes *in*. Distinct from {@link AuditRow} only in `metadata`, which
 * must be a concrete JSON value rather than `unknown` — the read and write
 * directions genuinely differ here, and collapsing them would mean casting.
 */
interface AuditRowInput extends Omit<AuditRow, "metadata"> {
  metadata: Record<string, string>;
}

interface AnchorRow {
  id: string;
  sequence: number;
  chainHash: string;
  anchorRef: string;
  network: string;
  anchoredAt: Date;
}

/**
 * The slice of the Prisma client these repositories need.
 *
 * Structural, so a transaction client satisfies it as readily as the root
 * one — the same convention every other repository here follows.
 */
export interface AuditDelegate {
  findFirst(args: { orderBy: { sequence: "desc" } }): Promise<AuditRow | null>;
  findMany(args: {
    where?: {
      sequence?: { gte: number };
      actorId?: string;
      subjectId?: string;
      action?: string;
      occurredAt?: { gte?: Date; lte?: Date };
      metadata?: { path: string[]; equals: string };
    };
    orderBy: { sequence: "asc" | "desc" };
    take: number;
  }): Promise<AuditRow[]>;
  create(args: { data: AuditRowInput }): Promise<AuditRow>;
  /**
   * Inserts several rows in one statement for the batched writer. `data` is mutable to match the
   * generated client's signature.
   */
  createMany(args: { data: AuditRowInput[] }): Promise<{ count: number }>;
  count(): Promise<number>;
}

/**
 * Runs `work` in one database transaction. Injected as a function so Prisma types stay in adapters
 * and the transaction boundary is explicit at the construction site.
 */
export type AuditTransaction = <T>(work: (entries: AuditDelegate) => Promise<T>) => Promise<T>;

interface AnchorDelegate {
  findFirst(args: { orderBy: { sequence: "desc" } }): Promise<AnchorRow | null>;
  findMany(args: { orderBy: { sequence: "desc" }; take: number }): Promise<AnchorRow[]>;
  create(args: { data: AnchorRow }): Promise<AnchorRow>;
}

/**
 * Reads `metadata` back as the flat string map the domain expects.
 *
 * `Json` comes out of Prisma as `unknown`, and the hash was computed over a
 * specific shape. Coercing defensively rather than casting means a row
 * corrupted by hand produces an entry whose hash does not verify — which is
 * exactly what should happen — instead of a runtime crash during
 * verification, when verification is the thing being relied upon.
 */
function toMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

/** Maps between audit rows and the domain entity. */
export const AuditLogEntryMapper = {
  toDomain(row: AuditRow): AuditLogEntry {
    return AuditLogEntry.reconstitute({
      id: asId<"AuditLogEntryId">(row.id),
      sequence: row.sequence,
      action: row.action as AuditAction,
      actorId: row.actorId ?? undefined,
      subjectId: row.subjectId ?? undefined,
      metadata: toMetadata(row.metadata),
      occurredAt: row.occurredAt,
      previousHash: row.previousHash,
      hash: row.hash,
    });
  },

  toRow(entry: AuditLogEntry): AuditRowInput {
    return {
      id: entry.id,
      sequence: entry.sequence,
      action: entry.action,
      actorId: entry.actorId ?? null,
      subjectId: entry.subjectId ?? null,
      metadata: { ...entry.metadata },
      occurredAt: entry.occurredAt,
      previousHash: entry.previousHash,
      hash: entry.hash,
    };
  },
};

/**
 * Prisma-backed, append-only `AuditLogRepository`.
 *
 * Append reads the head and inserts in one transaction, but under READ COMMITTED two writers can
 * read the same head. The unique index on `sequence` is the real guard: the losing insert raises
 * `P2002`, which is reported as the same `ChainConflictError` as a failed head check. Check and
 * insert stay in one method so callers cannot split them.
 */
export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(
    private readonly entries: AuditDelegate,
    private readonly transaction: AuditTransaction,
  ) {}

  async findLatest(): Promise<AuditLogEntry | undefined> {
    const row = await this.entries.findFirst({ orderBy: { sequence: "desc" } });
    return row === null ? undefined : AuditLogEntryMapper.toDomain(row);
  }

  append(
    entry: AuditLogEntry,
    expectedPreviousHash: string,
  ): Promise<Result<void, ChainConflictError>> {
    return this.appendMany([entry], expectedPreviousHash);
  }

  /**
   * Appends `entries` atomically, keeping only the whole batch or none of it.
   *
   * `entries.length === 0` is a no-op rather than an error: a flushed queue
   * that happened to drain empty is a normal tick, and making it an error
   * would push a pointless branch into every caller.
   */
  async appendMany(
    entries: readonly AuditLogEntry[],
    expectedPreviousHash: string,
  ): Promise<Result<void, ChainConflictError>> {
    if (entries.length === 0) {
      return Result.ok(undefined);
    }

    const batch = this.validateBatch(entries, expectedPreviousHash);
    if (Result.isErr(batch)) {
      return batch;
    }

    try {
      return await this.transaction<Result<void, ChainConflictError>>(async (tx) => {
        const head = await tx.findFirst({ orderBy: { sequence: "desc" } });
        const actualPreviousHash = head?.hash ?? GENESIS_HASH;

        if (actualPreviousHash !== expectedPreviousHash) {
          return Result.err(new ChainConflictError(expectedPreviousHash, actualPreviousHash));
        }

        // `create`, never `upsert`. An upsert would quietly overwrite an
        // existing entry at the same sequence, which is the one operation this
        // table must not permit — the unique index exists so a concurrent
        // append *fails*, and reaching for upsert to make that failure go away
        // would remove the guarantee rather than handle the race.
        await tx.createMany({ data: entries.map((entry) => AuditLogEntryMapper.toRow(entry)) });

        return Result.ok<void>(undefined);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Someone inserted between our read and our commit. The batch is
        // rolled back by the transaction, so the chain is still intact — this
        // is a lost race, not a corruption, and the caller's retry is safe.
        const head = await this.entries.findFirst({ orderBy: { sequence: "desc" } });
        return Result.err(new ChainConflictError(expectedPreviousHash, head?.hash ?? GENESIS_HASH));
      }
      throw error;
    }
  }

  /**
   * Rejects a batch that would not chain, before touching the database.
   *
   * A batch is only meaningful if each entry links to the one before it; if a
   * caller assembled entries from two different reads, inserting it would
   * write a chain that `verifyChain` reports as broken the moment anyone
   * checks. Failing fast turns that into a plain error at the call site.
   */
  private validateBatch(
    entries: readonly AuditLogEntry[],
    expectedPreviousHash: string,
  ): Result<void, ChainConflictError> {
    let previousHash = expectedPreviousHash;

    for (const entry of entries) {
      if (entry.previousHash !== previousHash) {
        return Result.err(new ChainConflictError(previousHash, entry.previousHash));
      }
      previousHash = entry.hash;
    }

    return Result.ok(undefined);
  }

  async findFrom(fromSequence: number, limit: number): Promise<readonly AuditLogEntry[]> {
    const rows = await this.entries.findMany({
      where: { sequence: { gte: fromSequence } },
      orderBy: { sequence: "asc" },
      take: limit,
    });
    return rows.map((row) => AuditLogEntryMapper.toDomain(row));
  }

  async findWithFilters(params: FindWithFiltersParams): Promise<readonly AuditLogEntry[]> {
    const where: {
      sequence?: { gte: number };
      actorId?: string;
      subjectId?: string;
      action?: string;
      occurredAt?: { gte?: Date; lte?: Date };
      metadata?: { path: string[]; equals: string };
    } = {
      sequence: { gte: params.fromSequence },
    };

    if (params.filters.actorId) {
      where.actorId = params.filters.actorId;
    }

    if (params.filters.subjectId) {
      where.subjectId = params.filters.subjectId;
    }

    if (params.filters.action) {
      where.action = params.filters.action;
    }

    if (params.filters.organizationId) {
      // organizationId is stored in metadata as a JSON field
      where.metadata = { path: ["organizationId"], equals: params.filters.organizationId };
    }

    if (params.filters.fromDate || params.filters.toDate) {
      where.occurredAt = {};
      if (params.filters.fromDate) {
        where.occurredAt.gte = params.filters.fromDate;
      }
      if (params.filters.toDate) {
        where.occurredAt.lte = params.filters.toDate;
      }
    }

    const rows = await this.entries.findMany({
      where,
      orderBy: { sequence: "asc" },
      take: params.limit,
    });

    return rows.map((row) => AuditLogEntryMapper.toDomain(row));
  }

  count(): Promise<number> {
    return this.entries.count();
  }
}

/**
 * Whether an error is Prisma's unique-constraint violation (`P2002`). Checked structurally to avoid
 * depending on the generated client; a false positive only causes a retry.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/** Prisma-backed `AnchorRecordRepository`. */
export class PrismaAnchorRecordRepository implements AnchorRecordRepository {
  constructor(
    private readonly records: AnchorDelegate,
    private readonly generateId: () => string,
  ) {}

  async save(record: AnchorRecord): Promise<void> {
    await this.records.create({ data: { id: this.generateId(), ...record } });
  }

  async findLatest(): Promise<AnchorRecord | undefined> {
    const row = await this.records.findFirst({ orderBy: { sequence: "desc" } });
    return row === null ? undefined : toAnchorRecord(row);
  }

  async findAll(limit: number): Promise<readonly AnchorRecord[]> {
    const rows = await this.records.findMany({ orderBy: { sequence: "desc" }, take: limit });
    return rows.map(toAnchorRecord);
  }
}

function toAnchorRecord(row: AnchorRow): AnchorRecord {
  return {
    sequence: row.sequence,
    chainHash: row.chainHash,
    anchorRef: row.anchorRef,
    network: row.network,
    anchoredAt: row.anchoredAt,
  };
}
