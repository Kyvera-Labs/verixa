import { randomUUID } from "node:crypto";

import { Result } from "@verixa/shared-kernel";

import {
  AnchorError,
  type AnchorReceipt,
  type HashAnchor,
  isValidSha256Hex,
} from "../../application/ports/hash-anchor.js";

/**
 * A `HashAnchor` backed by an in-memory `Map`, satisfying exactly the same
 * contract as {@link StellarHashAnchor}. Lets anything that anchors hashes
 * be tested without a network, a funded account, or a live ledger — and
 * lets a deployment that wants Verixa's audit log without any blockchain
 * dependency run with anchoring effectively disabled.
 *
 * `failNextAnchor()` exists because the interesting behavior in anchoring
 * code is usually the failure path: a scheduler must keep running and retry
 * on the next tick rather than crash when the ledger is unreachable, and
 * that's hard to test against an implementation that always succeeds.
 */
export class InMemoryHashAnchor implements HashAnchor {
  private readonly anchorsByRef = new Map<string, string>();
  private nextAnchorFails = false;

  /** Makes the next `anchor` call return an `AnchorError`, simulating an unreachable or rejecting ledger. */
  failNextAnchor(): void {
    this.nextAnchorFails = true;
  }

  anchor(hash: string): Promise<Result<AnchorReceipt, AnchorError>> {
    if (this.nextAnchorFails) {
      this.nextAnchorFails = false;
      return Promise.resolve(Result.err(new AnchorError("Simulated anchoring failure.")));
    }

    if (!isValidSha256Hex(hash)) {
      return Promise.resolve(
        Result.err(new AnchorError("Expected a 64-character lowercase hex SHA-256 digest.")),
      );
    }

    const anchorRef = randomUUID();
    this.anchorsByRef.set(anchorRef, hash);

    return Promise.resolve(
      Result.ok({
        hash,
        anchorRef,
        anchoredAt: new Date(),
        network: "in-memory",
      }),
    );
  }

  verify(hash: string, anchorRef: string): Promise<Result<boolean, AnchorError>> {
    if (!isValidSha256Hex(hash)) {
      return Promise.resolve(
        Result.err(new AnchorError("Expected a 64-character lowercase hex SHA-256 digest.")),
      );
    }

    return Promise.resolve(Result.ok(this.anchorsByRef.get(anchorRef) === hash));
  }
}
