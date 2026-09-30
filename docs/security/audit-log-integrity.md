# Audit Log Integrity

How Verixa keeps the audit log trustworthy — and, in this revision, how it
stops the audit log from becoming the easiest way to leak what it records.

This document is shared by several Phase 10 issues. The hash-chain,
verification and retention sections belong to Issues 183, 190, 191 and 192 and
will be added as those land; the section below is Issue 199's.

## Reading the audit log is a privileged, audited action

Implementation:
`packages/audit/domain/policies/audit-access-policy.ts` (the rules),
`packages/audit/application/audit-read-access.ts` (authorize-then-record),
`packages/audit/application/use-cases/query-audit-events.ts` and
`packages/audit/application/use-cases/export-audit-events.ts`.

### The rule

**Every read of an organization's audit log requires an explicit permission
within that organization, is refused for any other organization, and is itself
written to the audit log before a single entry is returned.**

### Why: the log is the most concentrated record in the system

An audit log answers "who did what, when, to whom" for an entire organization.
That is precisely what an attacker doing reconnaissance wants, and precisely
what a curious insider should not be able to browse. A system that protects
every individual record and then exposes the log of all of them has moved the
leak, not closed it.

Two failure modes matter, and they need different controls:

- **Unauthorized reads** — someone without a reason reads the log, or reads
  another tenant's. Closed by the permission check and the organization check.
- **Unobserved authorized reads** — someone with access uses it in a way
  nobody would sanction. No access check can stop this, because the access is
  legitimate. What stops it is that the read is recorded where the people
  reviewing access will see it. This is the "who audits the auditors" property
  compliance frameworks expect (SOC 2's monitoring criteria, ISO 27001 A.8.15),
  and it is the reason the self-record is not optional.

### Two permissions, not one

| Permission     | Grants                                                  |
| :------------- | :------------------------------------------------------ |
| `audit:query`  | A bounded page (at most `MAX_AUDIT_QUERY_PAGE_SIZE`)    |
| `audit:export` | A stream of the entire filtered history, for a download |

Export is bulk disclosure: the result leaves the system as a file and nobody
can take it back. Folding it into `audit:query` would mean everyone trusted to
look something up is trusted to walk away with everything. For the same
reason, the query page size is capped — without the cap, `limit: 10_000_000`
is an export reached with the weaker permission, and the two grants stop
meaning different things.

### Cross-organization requests are refused, not quietly rescoped

The alternative we rejected was to ignore the requested organization and
answer from the caller's own. It looks safe — no foreign data is ever
returned — but it turns an attempt to read another tenant's log into a
successful, unremarkable request. Nothing distinguishes the operator who
mistyped from the one probing tenants. Refusing makes the attempt an event,
and it is recorded as one (`audit.access_denied`, with the reason and the
caller's own organization).

The refusal message is identical whatever the reason. Telling a caller "that
organization is not yours" versus "you lack the permission" confirms which
organization IDs are real — the same enumeration reasoning as
[Authentication Flows](authentication-flows.md). The reason is kept on the
error for the audit record and deliberately left out of its serialized form.

There is no implicit "platform administrators may read every tenant" bypass.
When cross-tenant access is genuinely needed (Phase 16's admin tooling), it
should arrive as its own separately-granted permission, checked in
`authorizeAuditRead` where review will see it. Implicit bypasses are the
rules that end up applying to more people than intended.

### Recorded before the data is released, and fail closed

Both use cases write their `audit.queried` / `audit.exported` entry _before_
reading, and refuse with `AUDIT_READ_NOT_RECORDED` (503) if that write fails.

This is the opposite of what `RecordAuditEvent` does everywhere else, and the
difference is deliberate. When a login is audited, the login has already
happened; failing it because the audit write failed would report a false
negative to the user, so audit writes there are best-effort. A read of the
audit log has not happened yet. Refusing it costs one retry. Serving it anyway
would mean the reliable way to read the audit log unobserved is to break audit
writes first — which is exactly the attacker an audit log exists to catch.

For exports specifically, the record is written when the export _starts_, not
when it finishes. "Log a successful export on completion" reads more
naturally, but it gets the security property backwards: rows leave the system
from the first chunk, and a client that disconnects one row before the end
would have taken almost everything while leaving no trace. What is audited is
the disclosure, and the disclosure begins immediately.

Refusals, by contrast, are recorded best-effort. The caller is refused either
way, so failing to record the refusal cannot change the outcome.

### Pending: where permissions come from

Until Phase 07's RBAC is wired into the API (Phase 12), nothing in the running
application grants `audit:query` or `audit:export`. The use cases take an
`AuditReader` — actor, organization, and the permissions held _within that
organization_ — built by the interface layer from the authenticated session,
never from the request body. The composition root is responsible for
populating `permissions` from whatever resolves them; until it does, the set is
empty and every read is refused. That is the correct default: an audit API
that is unreachable until authorization exists is a missing feature, while one
that is reachable before authorization exists is a breach.

### Where scoping is enforced

`AuditEventReader` (`packages/audit/application/ports/audit-event-reader.ts`)
takes the organization as a required criterion, and the use cases fill it from
the _authorized_ organization rather than passing caller input through. An
adapter therefore never sees an unscoped read. It is a separate port from
`AuditLogRepository` for the same reason: that port must stay unscoped to
append to and verify the whole chain, and giving query callers access to it
would hand them a method that ignores tenancy.

### Tests

- `packages/audit/domain/policies/audit-access-policy.spec.ts` — the rules,
  including that one permission cannot stand in for the other and that the
  serialized refusal is identical for every reason.
- `packages/audit/application/use-cases/query-audit-events.spec.ts` and
  `export-audit-events.spec.ts` — cross-organization rejection without
  touching storage, the self-record written with actor, organization and
  filters, the export recorded before its stream is consumed, fail-closed
  behaviour when the record cannot be written, and the page-size cap.
