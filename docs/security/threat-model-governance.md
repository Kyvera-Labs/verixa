# Threat Model: Governance

This document records the security reasoning behind the governance context (`packages/governance`). It currently covers data retention enforcement. Later governance work adds its own sections.

Companion documents: `docs/security/threat-model-audit.md` (why the audit log is append-only), `docs/security/audit-log-integrity.md`, and the retention seam described in `packages/audit/application/ports/retention-policy.ts`.

---

## Why audit deletion is structurally disallowed

Retention enforcement is a deletion engine. Pointed at the wrong thing it is also the most direct way to destroy evidence: a job that is allowed to delete audit records can erase the trail of whatever it was asked to clean up after.

The audit log's value is that nothing has been removed (`threat-model-audit.md`). So the rule is not "the job should not delete audit data" but "the system has no path by which it could":

- **`PERMITTED_RETENTION_ACTIONS`** lists the actions each resource type may ever receive. `audit_export` permits `archive` only. A `delete` or `anonymize` rule for it is rejected when the rule is created.
- **The job checks the same table again** before it looks for a target. A rule rebuilt from storage skips creation, so a corrupted or tampered rule row that says `delete` is refused with a logged `refused` outcome, and no target is called.
- **No audit target offers delete.** The audit context's repository has no `delete` method at all, so there is nothing for a target to call even if both checks above failed.

Three independent layers, each of which would have to be removed for audit data to be deleted.

**Alternative rejected:** a runtime `if (resourceType === "audit") refuse` inside the job. A condition in code is one more place a later change can forget; a table that both rule creation and the job consult is reviewed in one place.

**Why archive is allowed:** archival moves records out of the hot store while keeping them retrievable and verifiable. It reduces cost and exposure without breaking the chain.

**What this does not solve.** Legally compelled erasure of personal data inside audit records is a real tension with append-only evidence. This design does not resolve it: erasure would have to arrive as its own reviewed mechanism that removes content while leaving an anchored digest, as described in `retention-policy.ts`. Until then, the answer to "delete this audit record" is no.

## Other retention threats

| Threat                                                                                     | Mitigation                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A rule for one organization deletes another organization's data                            | Every `RetentionTarget` method is scoped by organization, and the contract requires targets to refuse records outside it. Both context targets have tests for this. |
| Live data deleted because it is old (an active session, a verification still under review) | The contract requires `findExpired` to return only records whose own end of life has passed. Tested for both targets.                                               |
| A crash mid-run causes double processing or a skipped record                               | `apply` is idempotent and the job consults its log; a re-run changes nothing already done.                                                                          |
| A mistyped resource type or action silently enforces nothing, or the wrong thing           | Both are closed enums validated at rule creation. A rule with no registered target or an unsupported action is `refused` and logged, never silently skipped.        |
| Enforcement actions cannot be audited afterwards                                           | Every action, refusal and failure is appended to `RetentionActionLog` with rule id, resource id and action.                                                         |
| The action log is edited to hide a deletion                                                | Accepted for now: the in-memory log is process-local. The database-backed log should be written through the audit context so it inherits its tamper evidence.       |
