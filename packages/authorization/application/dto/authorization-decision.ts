import type { PolicyId } from "../../domain/entities/policy.js";

/**
 * Result of a single authorization check. `reason` is always populated, including for denials and
 * resolution failures, so it can be audited without re-running the check (see
 * docs/guides/use-cases.md).
 */
export interface AuthorizationDecision {
  readonly granted: boolean;
  readonly reason: string;
  readonly matchedPolicyIds: readonly PolicyId[];
  readonly evaluatedAt: Date;
}
