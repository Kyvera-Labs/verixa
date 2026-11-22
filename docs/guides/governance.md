# Governance policies

Governance policies are organization-scoped, versioned rulesets. A draft is an
authoring record only: it is never queried by the authorization runtime. A
published snapshot is translated into the ABAC engine's rule format and is
evaluated for requests belonging to the same organization. Archived snapshots
are likewise inactive.

## Policies vs. RBAC/ABAC

RBAC answers the coarse question “does this role have this permission?” ABAC
answers the contextual question “does this request's subject, resource, action,
and environment satisfy the rule?” Governance owns the lifecycle and approval
state of the policy; the authorization package owns evaluation. The
`PolicyEvaluationBridge` connects those boundaries by requesting only the
organization's published policies and translating them before evaluation.

Translation is deliberately fail-closed. The rejected alternative was to skip
an invalid policy and continue with the remaining rules, because that can turn
a malformed deny or boundary rule into an accidental permit. A malformed or
unpublished snapshot therefore produces `DENY`, never `NOT_APPLICABLE`.

See [Authorization](authorization.md) for how the ABAC result composes with
RBAC.
