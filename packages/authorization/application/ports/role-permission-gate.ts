import type { ResourceRef, SubjectRef } from "../../domain/attribute-context.js";

/**
 * The coarse-grained RBAC floor, consumed by the
 * composition service rather than reimplemented by it.
 *
 * This port answers exactly one question — "does this subject hold a role that
 * grants this action on this resource type?" — and nothing else. Attribute
 * conditions, policy documents, and precedence live in the ABAC layer, so an
 * implementation of this port stays cheap enough to run on every request.
 */

/** The three answers a role check can give. `no-match` is not a denial. */
export type RoleDecisionKind = "grant" | "deny" | "no-match";

/** Outcome of a role/permission check, with the grants that produced it. */
export interface RoleDecision {
  readonly kind: RoleDecisionKind;
  /** Stable explanation, for logs and the audit trail. */
  readonly reason: string;
  /** Roles the subject holds that were considered. */
  readonly roles: readonly string[];
  /** Permissions the subject holds that were considered. */
  readonly permissions: readonly string[];
}

/** The RBAC half of an authorization question. */
export interface RoleCheckRequest {
  readonly subject: SubjectRef;
  readonly action: string;
  readonly resource: ResourceRef;
}

/** Port implemented by the permission store (and by the cache in front of it). */
export interface RolePermissionGate {
  /**
   * Renders a role decision for the request.
   *
   * - "No matching role" is `no-match`, not an exception. Only an unreachable store may throw, and
   *   callers treat a throw as a denial.
   * - Never evaluates policy attributes or conditions; that belongs to the policy engine.
   * - Deterministic for a given store state.
   */
  check(request: RoleCheckRequest): Promise<RoleDecision>;
}
