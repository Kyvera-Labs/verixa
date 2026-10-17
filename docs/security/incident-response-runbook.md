# Security Incident Response Runbook

This runbook is for a security incident affecting Verixa or a deployment built
from it. It is written for a small open-source project without a dedicated
security operations team. The incident lead keeps the response coherent; the
maintainer with the relevant access performs each technical action. Do not
wait for perfect certainty before containing a credible active compromise.

## Principles and boundaries

- Protect people and evidence first. Preserve logs and a timeline before
  changing systems when that does not prolong active harm.
- Use the smallest containment action that stops the observed attack. A broad
  shutdown can erase evidence and create a second availability incident.
- Never put credentials, private keys, personal data, or exploit details in a
  public issue, pull request, or chat channel. Use the project's private
  security reporting route and restrict access to the incident record.
- Do not promise that data was not accessed unless logs and scope support that
  conclusion. Record what is known, unknown, and inferred separately.
- Follow the applicable deployment's legal, contractual, and regulator notice
  deadlines. This runbook does not replace jurisdiction-specific advice.

## Severity and escalation

Choose the highest level supported by current evidence. Reassess when scope
changes; severity is a response aid, not a statement of blame.

| Level | Meaning | Examples | Initial response |
| --- | --- | --- | --- |
| SEV-1 Critical | Active compromise or credible risk to many users, signing keys, or production data | Confirmed production credential theft; unauthorized admin access; forged identity/session tokens; destructive database access | Page the incident lead and affected deployment owner immediately; contain now; establish a private incident channel |
| SEV-2 High | A serious vulnerability is exploitable or a limited compromise is likely | Exposed secret with uncertain use; exploitable authentication bypass; confirmed access to one tenant | Incident lead and relevant maintainers respond promptly; contain the affected path; preserve evidence |
| SEV-3 Moderate | Security weakness with no evidence of exploitation and a bounded impact | Misconfiguration exposing non-sensitive metadata; repeated suspicious traffic blocked by controls | Assign an owner, verify exposure, and set a response deadline based on risk |
| SEV-4 Low | Hardening or low-impact issue without a plausible immediate exploit | Missing defense-in-depth header where no sensitive browser surface is served | Track privately or publicly as appropriate and fix through normal review |

Raise severity when exploitation is confirmed, impact expands, containment fails,
or evidence may be lost. Lower it only after the incident lead records why the
new evidence changes the assessment.

## Roles for a small project

One person may hold more than one role, but name each role explicitly in the
incident record.

- **Incident lead:** declares severity, maintains the timeline, assigns work,
  decides when to escalate, and approves the public status update.
- **Technical responder:** inspects the affected code and infrastructure,
  captures evidence, contains the attack, and proposes the smallest safe fix.
- **Deployment owner:** controls production accounts, keys, infrastructure,
  backups, and provider support. For a self-hosted installation this is the
  operator, not the upstream project.
- **Communications/contact owner:** handles affected-user notices and routes
  reports to the right private channel. The incident lead may take this role.
- **Recorder:** writes down timestamps, decisions, evidence locations, and
  unresolved questions. If only two people are available, the incident lead
  records decisions as they happen.

The project maintainers coordinate upstream code and releases. A deployment
owner controls its own secrets, production systems, user notices, and legal
obligations. Upstream maintainers must not claim to contain a deployment they
do not administer.

## First response: contain, assess, notify

### 1. Contain

1. Open a private incident record and assign an incident lead. Record the
   discovery time, reporter, affected version/deployment, and current evidence.
2. Preserve relevant access, application, identity-provider, database, and
   provider audit logs. Record their source, time range, timezone, and any
   collection gaps. Restrict access to the evidence.
3. Stop the active path: disable a compromised account or integration, block
   an abusive source where reliable, revoke affected sessions/tokens, or
   disable the affected endpoint. Avoid rotating unrelated secrets before
   determining dependencies.
4. If a secret may be compromised, revoke it at its issuer, issue a
   replacement through the documented secret-management path, update consumers,
   and verify the old value no longer works. Removing it from Git history does
   not revoke it.
5. If code is implicated, preserve the vulnerable revision and relevant
   artifacts, then deploy a reviewed mitigation. Keep the change narrow enough
   that rollback does not restore the exploit.

### 2. Assess

Build a scope table and mark each entry **confirmed**, **possible**, or
**checked and not observed**. Include affected service and versions, tenants or
accounts, data classes, time window, credentials, attacker access, and service
impact. Distinguish log absence from evidence that an event did not happen.

Check whether the same identity or secret was reused elsewhere, whether
sessions remain valid, whether audit data is trustworthy, and whether the
attacker could alter the evidence. Capture a copy of relevant records before
retention or rotation removes them. Document uncertainty and the next check
that could reduce it.

### 3. Notify

The incident lead informs the deployment owner and necessary maintainers through
a private channel, sharing only the minimum useful details. The deployment
owner determines affected-user, provider, regulator, and law-enforcement
notifications under their applicable obligations. Notify users with clear
facts: what happened, when, what information may be affected, what action was
taken, and what users should do. Do not include exploit instructions or
another user's information.

For a vulnerability not yet publicly fixed, use the repository's private
security reporting process. Coordinate a fix, release, and disclosure date
with the reporter. Public status updates should state what is known and when
the next update will arrive, even when the investigation is incomplete.

## Recovery and closure

1. Confirm the exploit path is closed and the revoked credential/session cannot
   be reused.
2. Restore service gradually and monitor the relevant signals. Keep a rollback
   path that does not re-enable the vulnerable behavior.
3. Verify backups and audit records before relying on them for recovery.
4. Close the incident only when containment is verified, required notifications
   are complete or assigned, and follow-up owners and dates are recorded.
5. Complete the review below within ten working days, while evidence and
   decisions are still fresh. A review improves the system; it is not a blame
   exercise.

## Post-incident review template

Copy this section into the private incident record.

- **Incident identifier / title:**
- **Incident lead / responders / deployment owner:**
- **Severity and rationale:**
- **Detected at / contained at / recovered at (include timezone):**
- **Affected versions, services, tenants, and data classes:**
- **Summary:** What happened in plain language?
- **Impact:** What is confirmed, possible, and not observed?
- **Timeline:** Timestamp, event or decision, evidence reference, owner.
- **Root cause and contributing conditions:** Include the control that failed
  and why the failure was possible.
- **Containment and recovery:** What worked, what did not, and how was it
  verified?
- **Notifications:** Who was notified, when, by whom, and what remains due?
- **Evidence and retention:** Where evidence is held, who can access it, and
  when it may be deleted.
- **Follow-up actions:** Each action has an owner, due date, and tracked issue.
- **What went well / what was difficult:**
- **Runbook or threat-model changes needed:**
- **Review date and participants:**

## Worked tabletop: credential-stuffing wave

**Scenario.** At 09:10 UTC, an operator sees a sharp rise in failed password
logins across many accounts. Requests originate from rotating addresses and
use previously leaked email/password pairs. Some accounts have successful
logins after repeated failures. No evidence yet shows database access.

**09:10 — Declare and preserve.** The deployment owner declares SEV-2 because
successes after repeated attempts suggest account compromise. The incident
lead opens a private record, captures the relevant API and identity-provider
logs, and notes clock offsets. The team does not post account identifiers or
sample passwords publicly.

**09:20 — Contain.** The responder blocks the most clearly abusive traffic at
the edge without treating an IP block as the only control. The operator
revokes sessions for accounts with suspicious successful logins and requires
password resets for those accounts. If the deployment has a configured rate
limiter, it is tightened at the login boundary and monitored for lockout abuse;
if it does not, the owner applies a temporary gateway limit and records that
limitation. Legitimate users must retain a recovery path.

**09:40 — Assess.** Responders compare failed and successful login events,
account lockout events, session issuance, MFA state, and administrative
activity over the attack window. They separate confirmed suspicious logins
from attempts that merely matched a known password. They check whether
successful sessions accessed identity, credential, or audit operations and
whether any signing or database secret was exposed. Lack of a recorded event is
not treated as proof if logging was unavailable.

**10:20 — Notify.** The deployment owner contacts users whose accounts show
confirmed suspicious sessions through a trusted channel, explains that
sessions were revoked, and gives reset guidance. Maintainers receive a
sanitized report if a code defect or missing control contributed. The owner
checks applicable notice obligations before making a public statement.

**After containment.** The team confirms revoked sessions fail, watches for
new attempts and account-recovery abuse, and only then relaxes temporary edge
limits. The review records the attack window, affected accounts, detection
latency, rate-limiter behavior, monitoring gaps, and a tracked owner/date for
each durable fix. The incident closes only after the residual risk and
notification status are explicit.

## Why this sequence

Containment comes before a complete root-cause explanation because ongoing
account takeover causes harm while responders investigate. Evidence capture
comes first only when it does not meaningfully prolong that harm. Broadly
shutting down authentication is a last resort: it can deny recovery to
legitimate users and can hide which control would have stopped the attack.
