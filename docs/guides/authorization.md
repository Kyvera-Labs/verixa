# Authorization

Authorization combines role permissions with organization-scoped ABAC policy
evaluation. RBAC denials remain final, while an explicit ABAC denial overrides
an RBAC grant. When no policy applies, the default is deny.

Governance-authored policies become runtime rules through the
[`PolicyEvaluationBridge`](governance.md#policies-vs-rbacabac). Only published
policy snapshots participate; drafts and archived policies have zero runtime
effect. Translation or policy-source failures fail closed.
