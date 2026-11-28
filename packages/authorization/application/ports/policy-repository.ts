import type { Policy, PolicyId } from "../../domain/entities/policy.js";

/**
 * Persistence port for {@link Policy}.
 *
 * - `save` stores the given version. Policies are immutable, so saving is append-only; saving the
 *   same `(id, version)` twice is idempotent. There is no update or delete.
 * - `findById` returns the latest version, or `undefined` if the id was never saved.
 * - `findApplicableTo` returns the latest version of every policy targeting the resource type and
 *   action. It is called on every request, so implementations must query narrowly.
 * - `listVersionsFor` returns every saved version, oldest first, or an empty array for an unknown
 *   id.
 */
export interface PolicyRepository {
  save(policy: Policy): Promise<void>;
  findById(id: PolicyId): Promise<Policy | undefined>;
  findApplicableTo(resourceType: string, action: string): Promise<Policy[]>;
  listVersionsFor(policyId: PolicyId): Promise<Policy[]>;
}
