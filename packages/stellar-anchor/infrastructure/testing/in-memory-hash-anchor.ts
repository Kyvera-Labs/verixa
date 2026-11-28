import { randomUUID } from "node:crypto";

import { Result } from "@verixa/shared-kernel";

import {
  AnchorError,
  type AnchorReceipt,
  type HashAnchor,
  isValidSha256Hex,
} from "../../application/ports/hash-anchor.js";

/**
 * Map-backed `HashAnchor` with the same contract as {@link StellarHashAnchor}, for tests without a
 * network and for deployments that run without a blockchain. `failNextAnchor()` lets tests exercise
 * the failure path, such as a scheduler retrying on the next run.
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
