import { createHash } from "node:crypto";

import { createId, type Id } from "@verixa/shared-kernel";

import {
  AuditMetadata,
  escapeForText,
  escapeJsonLineTerminators,
  utf8ByteLength,
} from "../value-objects/audit-metadata.js";

export type AuditLogEntryId = Id<"AuditLogEntryId">;

/**
 * The label prefixed to every canonical form.
 *
 * Changing how an entry is serialized changes its digest, and a chain written
 * under one rule and verified under another reports `content_altered` on every
 * entry after the change — an integrity alarm with no tampering behind it.
 * Naming the form in the form means that if this ever has to change again, the
 * version that produced a given hash travels with the hash.
 */
const CANONICAL_FORM_VERSION = "verixa-audit-v2";

/**
 * What happened. A closed set rather than a free string, so a query for
 * "every failed login last week" cannot miss entries because someone wrote
 * `login_failed` in one place and `LOGIN_FAILURE` in another.
 */
export type AuditAction =
  | "user.registered"
  | "user.email_verified"
  | "user.password_changed"
  | "user.status_changed"
  | "user.profile_updated"
  | "organization.invitation_created"
  | "user.login_succeeded"
  | "user.login_failed"
  | "user.locked_out"
  | "user.email_verification_requested"
  | "user.password_reset_requested"
  | "user.password_reset_completed"
  // Reads of the audit log itself — see `domain/policies/audit-access-policy.ts`.
  | "audit.queried"
  | "audit.exported"
  | "audit.access_denied"
  // API key lifecycle (Issue 233)
  | "api_key.created";

/**
 * The genesis link.
 *
 * The first entry in a chain has no predecessor, and needs *something* in the
 * position where a previous hash would go — otherwise the first entry's hash
 * is computed over a different shape than every other entry's, and the
 * verification loop needs a special case. Sixty-four zeroes is the
 * conventional choice and keeps the shape uniform.
 */
export const GENESIS_HASH = "0".repeat(64);

interface AuditLogEntryProps {
  readonly id: AuditLogEntryId;
  readonly sequence: number;
  readonly action: AuditAction;
  readonly actorId: string | undefined;
  readonly subjectId: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly occurredAt: Date;
  readonly previousHash: string;
  readonly hash: string;
}

/**
 * One tamper-evident audit record. Each entry's hash covers its predecessor's hash and its own
 * content, so altering or removing an entry breaks every later hash.
 *
 * Chaining is tamper-evident, not tamper-proof: someone with full database access can rewrite the
 * whole chain. Anchoring the head to Stellar closes that gap (see
 * `docs/adr/0003-stellar-audit-anchoring.md`). Entries are append-only and have no update or
 * delete.
 */
export class AuditLogEntry {
  readonly id: AuditLogEntryId;
  readonly sequence: number;
  readonly action: AuditAction;
  readonly actorId: string | undefined;
  readonly subjectId: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly occurredAt: Date;
  readonly previousHash: string;
  readonly hash: string;

  private constructor(props: AuditLogEntryProps) {
    this.id = props.id;
    this.sequence = props.sequence;
    this.action = props.action;
    this.actorId = props.actorId;
    this.subjectId = props.subjectId;
    this.metadata = props.metadata;
    this.occurredAt = props.occurredAt;
    this.previousHash = props.previousHash;
    this.hash = props.hash;
  }

  /**
   * The canonical bytes an entry's hash is computed over: fixed field order, sorted metadata keys,
   * and a UTF-8 byte length before every field.
   *
   * Length prefixes matter because fields such as `actorId` come from outside. With a plain
   * separator, actor `a\nb` plus subject `c` would hash the same as actor `a` plus subject `b\nc`.
   * The format is versioned and byte-based so the digest can be re-derived from stored columns
   * without this code.
   */
  private static canonicalize(props: Omit<AuditLogEntryProps, "hash" | "id">): string {
    const fields = [
      String(props.sequence),
      props.action,
      props.actorId ?? "",
      props.subjectId ?? "",
      props.occurredAt.toISOString(),
      props.previousHash,
      AuditMetadata.of(props.metadata).canonicalForm,
    ];

    const framed = fields.map((field) => `${String(utf8ByteLength(field))}:${field}`).join("|");

    return `${CANONICAL_FORM_VERSION} ${String(fields.length)} ${framed}`;
  }

  /** SHA-256 over {@link canonicalize}, hex-encoded. */
  private static computeHash(props: Omit<AuditLogEntryProps, "hash" | "id">): string {
    return createHash("sha256").update(AuditLogEntry.canonicalize(props), "utf8").digest("hex");
  }

  /**
   * Appends an entry after `previous`, or starts a chain when it is
   * `undefined`.
   *
   * Taking the predecessor rather than a bare hash is what makes a broken
   * chain hard to construct by accident: the caller has to have actually read
   * the tail of the log.
   */
  static append(params: {
    action: AuditAction;
    actorId?: string | undefined;
    subjectId?: string | undefined;
    metadata?: Readonly<Record<string, string>> | undefined;
    previous?: AuditLogEntry | undefined;
    occurredAt?: Date | undefined;
  }): AuditLogEntry {
    const body = {
      sequence: params.previous === undefined ? 1 : params.previous.sequence + 1,
      action: params.action,
      actorId: params.actorId,
      subjectId: params.subjectId,
      metadata: params.metadata ?? {},
      occurredAt: params.occurredAt ?? new Date(),
      previousHash: params.previous?.hash ?? GENESIS_HASH,
    };

    return new AuditLogEntry({
      id: createId<"AuditLogEntryId">(),
      ...body,
      hash: AuditLogEntry.computeHash(body),
    });
  }

  /** Rebuilds from already-trusted data (a database row). */
  static reconstitute(props: AuditLogEntryProps): AuditLogEntry {
    return new AuditLogEntry(props);
  }

  /**
   * Whether this entry's stored hash matches its content.
   *
   * Recomputed rather than trusted, which is the entire point: a stored hash
   * that is simply read back proves nothing, because an attacker editing the
   * row would edit the hash too. The check only means something when the
   * digest is derived again from the content.
   */
  /**
   * The hash this entry's *content* produces, recomputed from scratch.
   *
   * Distinct from {@link hash}, which is whatever the row happens to store.
   * The two agree only while the record is intact, so anything comparing an
   * entry against an external commitment must use this one -- comparing the
   * stored hash to a ledger means comparing a tampered row's own claim about
   * itself, which always agrees.
   */
  get recomputedHash(): string {
    return AuditLogEntry.computeHash({
      sequence: this.sequence,
      action: this.action,
      actorId: this.actorId,
      subjectId: this.subjectId,
      metadata: this.metadata,
      occurredAt: this.occurredAt,
      previousHash: this.previousHash,
    });
  }

  get hasValidHash(): boolean {
    return this.hash === this.recomputedHash;
  }

  /**
   * Projection of this entry that is safe for line-oriented sinks: no field can contain a line
   * break, so one entry is always one line. It changes only the rendering, never what is stored or
   * hashed.
   */
  toLogFields(): Readonly<Record<string, string>> {
    // `sequence`, `occurredAt`, and the two hashes are structurally safe — a
    // number, an ISO timestamp, and hex. Everything that came from outside the
    // process is escaped, and the metadata bag goes through the JSON-specific
    // treatment instead of `escapeForText` (see `escapeJsonLineTerminators`).
    return {
      sequence: String(this.sequence),
      action: escapeForText(this.action),
      actorId: escapeForText(this.actorId ?? ""),
      subjectId: escapeForText(this.subjectId ?? ""),
      occurredAt: this.occurredAt.toISOString(),
      previousHash: this.previousHash,
      hash: this.hash,
      metadata: escapeJsonLineTerminators(JSON.stringify(this.metadata) ?? "{}"),
    };
  }
}

/** Why a chain failed verification. */
export interface ChainBreak {
  readonly sequence: number;
  readonly reason: "content_altered" | "link_broken" | "sequence_gap";
}

/**
 * Verifies a contiguous run of entries, seeded with the entry before the run, so a large log can be
 * verified page by page. Pass `undefined` for the run that starts the chain.
 */
export function verifyChainFrom(
  previous: AuditLogEntry | undefined,
  entries: readonly AuditLogEntry[],
): ChainBreak | undefined {
  let predecessor = previous;

  for (const entry of entries) {
    if (!entry.hasValidHash) {
      return { sequence: entry.sequence, reason: "content_altered" };
    }

    const expectedPreviousHash = predecessor?.hash ?? GENESIS_HASH;
    if (entry.previousHash !== expectedPreviousHash) {
      return { sequence: entry.sequence, reason: "link_broken" };
    }

    const expectedSequence = predecessor === undefined ? 1 : predecessor.sequence + 1;
    if (entry.sequence !== expectedSequence) {
      return { sequence: entry.sequence, reason: "sequence_gap" };
    }

    predecessor = entry;
  }

  return undefined;
}

/**
 * Verifies a chain in order and reports the first break; later breaks are consequences of the
 * first.
 *
 * - `content_altered`: an entry's hash no longer matches its content.
 * - `link_broken`: an intact entry does not follow its predecessor, as after a deletion.
 * - `sequence_gap`: the numbering skips, catching a removal that re-derived the hashes but not the
 *   counter.
 */
export function verifyChain(entries: readonly AuditLogEntry[]): ChainBreak | undefined {
  return verifyChainFrom(undefined, entries);
}
