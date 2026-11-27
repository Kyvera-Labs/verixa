import { DomainError, type Result } from "@verixa/shared-kernel";

/** Proof that a specific hash was committed to an external ledger at a specific time. */
export interface AnchorReceipt {
  /** The 64-character hex SHA-256 digest that was anchored. */
  readonly hash: string;
  /**
   * Implementation-specific handle for looking the commitment back up —
   * a Stellar transaction hash for {@link StellarHashAnchor}. Opaque to
   * callers: they store it and pass it back to `verify`, never parse it.
   */
  readonly anchorRef: string;
  readonly anchoredAt: Date;
  /** Which ledger/network the commitment lives on, e.g. `stellar:testnet`. */
  readonly network: string;
}

/**
 * Anchoring failed in a way the caller can reasonably react to — the network
 * was unreachable, the account was underfunded, the ledger rejected the
 * transaction. Returned in a `Result` rather than thrown because a caller
 * anchoring on a schedule should log and retry on the next tick, not crash
 * (see `docs/guides/error-handling.md` on which failures get which
 * treatment).
 */
export class AnchorError extends DomainError {
  readonly code = "ANCHOR_FAILED";
  // 502: this represents an upstream ledger the caller depends on failing,
  // not a mistake in the caller's own request.
  readonly httpStatusHint = 502;
}

/**
 * Commits a hash to an append-only external ledger and checks a committed one. Hash chaining makes
 * the audit log tamper-evident, but someone with database access could rewrite the whole chain
 * consistently; committing the head outside that trust boundary prevents it (see
 * docs/adr/0003-stellar-audit-anchoring.md). Ledger-agnostic, so a deployment can use a different
 * anchor or none.
 */
export interface HashAnchor {
  /**
   * Commits `hash` to the ledger. `hash` must be a 64-character hex-encoded
   * SHA-256 digest — exactly 32 bytes, which is what a Stellar `MEMO_HASH`
   * holds.
   */
  anchor(hash: string): Promise<Result<AnchorReceipt, AnchorError>>;

  /**
   * Confirms that `anchorRef` commits to `hash`. Resolves `false` when it does not match, and
   * returns `AnchorError` only when the check could not complete. `anchorRef` is the transaction
   * hash from `anchor()`; network implementations validate it as 64 hex characters before using it
   * in a request.
   */
  verify(hash: string, anchorRef: string): Promise<Result<boolean, AnchorError>>;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** Whether `value` is a 64-character lowercase hex SHA-256 digest — the only shape {@link HashAnchor.anchor} accepts. */
export function isValidSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}
