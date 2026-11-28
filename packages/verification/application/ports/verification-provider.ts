import type { Evidence } from "../../domain/entities/evidence.js";
import type { ProviderCheckResult } from "../dtos/provider-check-result.js";

/**
 * A third-party identity-verification vendor behind a port, chosen in the composition root so
 * swapping vendors is a one-file change (see docs/guides/verification-provider-integration.md).
 *
 * Every implementation must:
 *
 * - Return a normalized {@link ProviderCheckResult}, never vendor types; return `inconclusive` if
 *   the answer cannot be mapped.
 * - Return `inconclusive` whenever it cannot decide.
 * - Never decide the request. It gives an opinion; `RunAutomatedCheck` records it and sends the
 *   case to a human reviewer regardless.
 * - Not throw for a negative result. Throw only when the check itself could not run.
 * - Read evidence bytes through `EvidenceStorage`, treating `evidence.storageRef` as opaque.
 * - Validate its result with `ProviderCheckResult.isValid` before returning.
 */
export interface VerificationProvider {
  /**
   * Checks a document evidence item (government ID, proof of address) and
   * returns a normalized outcome.
   */
  checkDocument(evidence: Evidence): Promise<ProviderCheckResult>;

  /**
   * Checks a liveness/selfie evidence item and returns a normalized outcome.
   */
  checkLiveness(evidence: Evidence): Promise<ProviderCheckResult>;
}
