# Organization hierarchy

Organizations may have an optional `parentOrganizationId`. A root organization
stores `null`; a child points directly to its parent, and
`GET /organizations/:organizationId/children` returns only those direct
children.

The hierarchy is deliberately shallow, not arbitrary depth. The product need is
business units under a tenant, while an arbitrary tree would add recursive
queries, deeper cycle detection, and more complicated authorization semantics.
Rejecting a child whose proposed parent is itself already a child keeps the
invariant explicit and leaves room to widen the model later if real usage
requires it.
