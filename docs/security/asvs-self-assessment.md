# OWASP ASVS 4.0.3 Platform Self-Assessment

## Scope and confidence

This assessment supersedes the credentials-only assessment below. It evaluates
the repository at the revision containing this document, with emphasis on the
application code in `apps/api` and `packages/*`. It does not certify a deployed
system: deployment configuration, identity-provider settings, network policy,
backups, and operator procedures must be verified by each deployment owner.

The target is **OWASP ASVS 4.0.3, Level 1**, with Level 2 controls included
where Verixa handles authentication, authorization, identity evidence, or
audit records. ASVS 4.0.3 is used to preserve the chapter mapping expected by
the existing V2 assessment and this project's Phase 11 requirements. The
standard's official [release and requirement identifiers](https://github.com/OWASP/ASVS/tree/v4.0.3) are version-pinned because control numbers change across releases.

This is a source review, not a penetration test. A **PASS** means the cited
code or automated check provides evidence for the specific control in the
repository; it does not assert production configuration. **FAIL** identifies a
missing or incomplete control. **N-A** means the requirement does not apply to
the API-only surface in this repository, with the reason stated. Partial
implementations are failures. The linked phase specification is the tracked
follow-up area for each gap; maintainers should split individual work items
when scheduling them.

## Chapter assessment

| ASVS chapter                                | Status | Evidence and rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1 Architecture, Design and Threat Modeling | PASS   | Context-specific threat models and architecture constraints exist under `docs/security/` and `planning/ARCHITECTURE.md`; the dependency direction is enforced in code and lint configuration. This is a source-level review, not an independent threat-model workshop.                                                                                                                                                                                                                                                                                                                                                                                             |
| V2 Authentication                           | FAIL   | Password hashing, password policy, account lockout, verification, reset, and MFA are implemented. Rate limiting remains a no-op in composition and production mail delivery is not configured. Follow up: [Phase 11, Issue 209 — brute-force protection](../../planning/issues/phase-11-security-hardening.md#issue-209-platform-wide-brute-force-protection-policy), [Phase 15, Issue 283 — real rate limiter](../../planning/issues/phase-15-rate-limiting.md#issue-283-rate-limiter-adapter-satisfying-issue-074s-port), and [Phase 14](../../planning/issues/phase-14-notifications.md).                                                                       |
| V3 Session Management                       | FAIL   | Signed access tokens, hashed refresh tokens, expiry, revocation and reuse detection are implemented and described in `docs/security/threat-model-sessions.md`. Browser cookie policy and deployment key rotation are not established by this API repository. Follow up: [Phase 11, Issue 214 — secure cookie configuration](../../planning/issues/phase-11-security-hardening.md#issue-214-secure-cookie-configuration) and [Phase 20, Issue 391 — secrets management guidance](../../planning/issues/phase-20-docker-deployment.md#issue-391-secrets-management-guidance-provider-abstraction).                                                                   |
| V4 Access Control                           | FAIL   | RBAC/ABAC policy evaluation and guarded authorization routes exist. Tenant-boundary behavior and route-by-route authorization coverage still require integration review. Follow up: [Phase 07, Issue 137 — principal resolution](../../planning/issues/phase-07-rbac.md#issue-137-request-scoped-principal-resolution-per-request-caching), [Phase 08, Issue 153 — authorization API](../../planning/issues/phase-08-abac-policy-engine.md#issue-153-policy-decision-point-authorize-use-case-api), and [Phase 12, Issue 239 — REST security review](../../planning/issues/phase-12-rest-api.md#issue-239-appsapi-rest-layer-threat-model-security-review).        |
| V5 Validation, Sanitization and Encoding    | FAIL   | Fastify JSON schemas reject unknown request properties, and domain value objects validate inputs. A platform-wide input/output boundary and encoding review is incomplete. Follow up: [Phase 12, Issue 222 — validation and error contract](../../planning/issues/phase-12-rest-api.md#issue-222-zod-to-openapi-schema-bridge) and [Issue 239 — REST security review](../../planning/issues/phase-12-rest-api.md#issue-239-appsapi-rest-layer-threat-model-security-review).                                                                                                                                                                                       |
| V6 Stored Cryptography                      | FAIL   | Passwords and bearer tokens are stored as hashes. Database encryption-at-rest and key custody are external deployment controls, not proven by this repository. Follow up: [Phase 11, Issue 206 — secrets management](../../planning/issues/phase-11-security-hardening.md#issue-206-secrets-management-policy-loader-hardening) and [Phase 20, Issue 386 — database persistence and backups](../../planning/issues/phase-20-docker-deployment.md#issue-386-postgres-and-redis-persistence-backup-volumes-in-compose).                                                                                                                                              |
| V7 Error Handling and Logging               | FAIL   | Shared error response mapping, structured logging, redaction, and audit-chain verification are implemented. A complete review of error paths and deployed log sinks is outstanding. Follow up: [Phase 12, Issue 237 — request logging and correlation IDs](../../planning/issues/phase-12-rest-api.md#issue-237-correlation-id-propagation-structured-request-logging) and [Phase 18](../../planning/issues/phase-18-observability.md).                                                                                                                                                                                                                            |
| V8 Data Protection                          | FAIL   | Credential/token serialization avoids exposing secret material, and audit metadata is schema-constrained. Retention, deletion, and data-subject lifecycle are incomplete or deployment-dependent. Follow up: [Phase 24, Issue 469 — retention policy model](../../planning/issues/phase-24-compliance-privacy.md#issue-469-retention-policy-domain-model), [Issue 470 — retention enforcement](../../planning/issues/phase-24-compliance-privacy.md#issue-470-retention-enforcement-scheduled-job), and [Issue 466 — erasure](../../planning/issues/phase-24-compliance-privacy.md#issue-466-hard-erasure-use-case-for-eligible-records).                          |
| V9 Communications                           | FAIL   | TLS termination, certificate lifecycle, and secure transport between production components are operator controls not established by this repository. Follow up: [Phase 11, Issue 213 — TLS enforcement and HSTS](../../planning/issues/phase-11-security-hardening.md#issue-213-tls-enforcement-hsts) and [Phase 20, Issue 387 — TLS termination](../../planning/issues/phase-20-docker-deployment.md#issue-387-reverse-proxy-tls-termination-compose-service).                                                                                                                                                                                                    |
| V10 Malicious Code                          | FAIL   | Dependency lockfiles and CI checks provide reproducible resolution, but continuous vulnerability scanning and a response SLA are not established. Follow up: [Phase 11, Issue 207 — dependency scanning](../../planning/issues/phase-11-security-hardening.md#issue-207-dependency-scanning-in-ci) and [Phase 19, Issue 364 — security scanning workflow](../../planning/issues/phase-19-cicd-automation.md#issue-364-security-scanning-workflow-audit-osv-scanner-codeql).                                                                                                                                                                                        |
| V11 Business Logic Security                 | FAIL   | Invariants live in domain value objects/use cases and have focused tests, but this assessment did not review every workflow or concurrency boundary. Follow up: [Phase 12, Issue 239 — REST threat model and security review](../../planning/issues/phase-12-rest-api.md#issue-239-appsapi-rest-layer-threat-model-security-review) and the context-specific phase issue for each affected workflow.                                                                                                                                                                                                                                                               |
| V12 Files and Resources                     | N-A    | The assessed API does not currently accept user-uploaded files or expose file-serving endpoints. Reassess if a context adds uploads, exports, or user-controlled file retrieval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| V13 API and Web Service                     | FAIL   | Fastify schemas and explicit route handlers define API boundaries; the OpenAPI contract is being established. Authentication, authorization, pagination, versioning, and error contracts are not yet assessed as one complete surface. Follow up: [Phase 12, Issue 221 — OpenAPI contract](../../planning/issues/phase-12-rest-api.md#issue-221-openapi-first-contract-authoring-workflow), [Issue 239 — REST security review](../../planning/issues/phase-12-rest-api.md#issue-239-appsapi-rest-layer-threat-model-security-review), and [Issue 234 — principal rate limiting](../../planning/issues/phase-12-rest-api.md#issue-234-rate-limiting-per-principal). |
| V14 Configuration                           | FAIL   | Environment parsing validates required secrets and fails closed for selected settings. Secure defaults for headers, CORS/CSRF, secret rotation, and all production options are not established. Follow up: [Phase 11, Issue 206 — secrets management](../../planning/issues/phase-11-security-hardening.md#issue-206-secrets-management-policy-loader-hardening), [Issue 204 — CORS](../../planning/issues/phase-11-security-hardening.md#issue-204-cors-policy), and [Phase 20, Issue 389 — environment configuration matrix](../../planning/issues/phase-20-docker-deployment.md#issue-389-environment-configuration-matrix-dev-test-staging-production).        |

## Evidence by security area

### Authentication and credentials (V2)

The previous V2 assessment remains useful as implementation evidence, but its
scope and version claims are superseded by this document. The code uses Argon2
for password hashing, central password policy validation, account lockout,
email verification and password-reset tokens stored as digests, and
single-use recovery flows. MFA implementations include WebAuthn verification.
Relevant sources include:

- `packages/credentials/domain/value-objects/raw-password.ts`
- `packages/credentials/infrastructure/crypto/argon2-password-hasher.ts`
- `packages/credentials/application/use-cases/authenticate-with-password.ts`
- `packages/credentials/application/use-cases/confirm-password-reset.ts`
- `packages/mfa/infrastructure/webauthn/`
- `docs/security/authentication-flows.md`

A no-op rate limiter is wired in `apps/api/src/composition-root.ts`. It is a
known gap, not a production defense. Until a real adapter is configured,
operators need a gateway limit and monitoring. Account lockout alone is not a
substitute: attackers can use it to deny service to targeted users.

### Sessions and authorization (V3–V4)

Session token signing and verification, hashed refresh-token persistence,
expiry, revocation, and replay detection are covered in
`packages/sessions/` and `docs/security/threat-model-sessions.md`. The API
composition root requires a configured signing secret rather than silently
using a development key. This repository does not establish browser cookie
flags, reverse-proxy trust, or production secret rotation; those need deployment
verification.

RBAC and policy evaluation live in `packages/authorization/`. A library-level
guard is not evidence that every exposed route uses it correctly. Review each
route with a principal and tenant boundary test before relying on the result in
a multi-tenant deployment. Known architecture and phase work is tracked in
the Phase 07, 08, and 12 specifications above.

### Input, output, errors, and logs (V5, V7, V11, V13)

The Fastify application sets `removeAdditional: false`; malformed requests
with undeclared fields are rejected instead of silently rewritten. Route
schemas validate request shape, while domain objects enforce business
invariants. This division avoids maintaining the same policy twice. It does
not by itself prove safe output encoding in every future consumer, and this
API has no browser templating layer to assess for HTML encoding.

Shared error mapping avoids leaking internal exception details through
responses. Structured logs redact configured sensitive fields, while audit
records use action-specific metadata schemas. Operators must still protect
log access, retention, backups, and alerting. An audit log is not a substitute
for operational logs, and neither should record passwords, tokens, or private
keys.

### Cryptography, data, and communications (V6, V8, V9)

Passwords and refresh tokens are not stored in recoverable form. Cryptographic
keys used for tokens and Stellar anchoring have dedicated configuration and
key-management guidance. These code-level decisions do not demonstrate
storage-volume encryption, TLS between services, certificate rotation, backup
protection, or key custody in a deployed environment. Deployment owners must
record those controls and verify their evidence separately.

### Supply chain, configuration, and operations (V10, V14)

The repository pins dependency resolution in `pnpm-lock.yaml` and has CI
workflows for quality checks. A lockfile proves a resolution, not that every
transitive package is free of known vulnerabilities or that alerts are
reviewed. The Phase 19 specification tracks pipeline automation. Configuration
is parsed through `packages/config`; selected dangerous settings fail closed,
but this source review did not validate every production environment or
secret-rotation procedure. See the Phase 11 and Phase 20 specifications.

## Earlier credentials-only findings

The old V2 assessment described password maximum length as a failure because
the configured cap exceeded the cited ASVS threshold. Treat that as an
unresolved policy decision until the credential owner explicitly maps the
current rule to the chosen standard requirement. Do not change a password
limit solely to make this table look better: compare denial-of-service
protection, password-manager compatibility, and the precise ASVS wording first.

## Verification and maintenance

For each PASS, reviewers should be able to follow the cited path and inspect
its tests. For each FAIL, the linked phase issue is the tracked
follow-up area; maintainers should open a narrowly scoped issue when the work
is scheduled. This document must be re-reviewed after changes to authentication,
sessions, authorization, API routes, cryptographic storage, dependency policy,
or deployment configuration.

A future revision should include a requirement-by-requirement checklist keyed
to the pinned ASVS release and attach test or deployment evidence. This
chapter-level mapping is an honest first platform-wide assessment, not a
claim that every individual ASVS requirement has been verified.
