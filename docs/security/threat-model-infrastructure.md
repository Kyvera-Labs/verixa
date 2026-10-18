# Threat Model: Platform Infrastructure

The layer no bounded context owns: the network path to the process, the Fastify
process boundary itself, the container it runs in, the dependency graph it is
built from, and the trust assumptions between services that are one modular
monolith today but have service-ready seams (ARCHITECTURE.md §7).

Credentials, audit and the policy engine each have their own STRIDE model. Those
models assume the platform they run on is sound — that the transport is not
being read, that the process has not been taken over, that the image is what
this repository built. This document is where that assumption is examined
instead of inherited.

Roadmap Issue 202 (GitHub #143). Related: the transport and header controls in
Issues 203/213, the platform controls in Issues 204/206/207/208/215/216, and the
per-context models linked at the end.

## Scope and assumptions

**In scope**

- The network path between a client and the API process (TLS, plaintext,
  proxy-mediated trust).
- The Fastify process boundary: response headers, CORS, configuration loading,
  and what an attacker who reaches a route can do beyond the route.
- The container runtime: base image, user, filesystem, secrets mounted into the
  process.
- The dependency and build chain: what `pnpm-lock.yaml` resolves to, what CI
  runs, and what the image contains.
- The seams where a future split into services would put a network trust
  boundary.

**Out of scope (and why)**

- **Per-context threats** — account enumeration, token replay, audit tampering,
  policy bypass — are covered by their own models. Duplicating them here would
  create two rows that drift.
- **Application-level authorization decisions.** A route that returns data it
  should not has a flaw the headers in this model cannot reach; the RBAC and
  ABAC models own that.
- **The hosting provider and its hypervisor.** A cloud provider compromise is
  outside any control this repository can implement, and pretending otherwise
  is the "mitigated by trust" pattern this document exists to avoid.
- **End-user device compromise.** A keylogger on the client defeats every
  control here, and nothing a server does changes that.

**Assumed attacker capabilities**

1. **Network attacker** — able to read, delay and drop packets, and to present
   any `Origin` or `X-Forwarded-*` header it likes. Cannot break TLS.
2. **Unauthenticated internet client** — can call any route, with any body,
   many times, from many addresses.
3. **Deployment operator** — can set environment variables and container
   flags. Trusted to be non-malicious; _not_ assumed to be perfectly
   configured. Every "fails safe under operator error" claim below is a claim
   about this actor.
4. **Registry/ecosystem attacker** — can publish a package, or take over a
   maintainer account, but cannot rewrite history in this repository.
5. **Compromised dependency running with the process's privileges** — the
   consequence assumed by the RCE rows below.

Threats outside these assumptions are not mitigated; they are unexamined, and
this list is what makes that visible.

## Assets

| Asset                                  | Why it matters                                                          |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Session cookies and bearer tokens      | Whoever holds one is the user; theft is account takeover.               |
| `SESSION_ACCESS_TOKEN_SECRET`          | Forges access tokens for any user.                                      |
| Database and Redis credentials         | Read or rewrite every tenant's data, including audit history.           |
| Password hashes and MFA secrets        | Offline cracking, permanent account compromise.                         |
| Audit-log integrity                    | The record a security incident is reconstructed from.                   |
| Tenant isolation                       | Cross-tenant reads are the worst-case single-request failure.           |
| The release artifact (image, lockfile) | What every deployment actually runs, and what downstream users consume. |

## Trust boundaries and entry points

```text
 internet ──TLS──▶ reverse proxy ──plaintext, X-Forwarded-*──▶ Fastify process
                                                                    │
                                       config (env) ───────────────┤
                                       Postgres / Redis ────────────┤
                                                                    │
                          container runtime ──▶ host kernel ────────┘
                          dependency graph ──▶ process memory
```

Crossings that matter, in the order an attacker meets them:

1. **Client → TLS terminator.** Untrusted input, credentials, and the `Origin`
   header. The terminator is trusted for client identity via
   `X-Forwarded-Proto`/`X-Forwarded-For` — but only when `TRUST_PROXY` says one
   exists.
2. **Proxy → API process.** Plaintext on a private interface. Safe only because
   the process is not reachable from outside the proxy.
3. **Client → route handlers.** The largest untrusted surface; per-context
   models own what happens after entry, this model owns the process-level
   response.
4. **Environment → process.** `process.env` is read in exactly one place
   (`@verixa/config`); everything downstream trusts the validated value.
5. **Dependency graph → process.** Code chosen by the lockfile runs with full
   process privileges.
6. **Process → container → host.** A process compromise becomes a host
   compromise only through a runtime misconfiguration.

## Threats

### Spoofing

#### INFRA-S-1: Forged client identity through forwarded headers

- **STRIDE category:** Spoofing
- **Actor:** Network attacker, or any unauthenticated client
- **Entry point:** `X-Forwarded-Proto` / `X-Forwarded-For` on any route
- **Asset:** Client identity used for redirects, logging, and (once Issue 209
  lands) rate limiting and lockout
- **Description:** Send `X-Forwarded-For: <trusted address>` to appear to be
  someone else, or `X-Forwarded-Proto: https` to skip the plaintext redirect and
  send credentials over HTTP. Both only work if the process believes headers
  that arrived from the internet.
- **Impact:** IP-based blocklists and lockout are bypassed; the redirect that is
  supposed to protect credentials is skipped.
- **Mitigation:** `TRUST_PROXY` defaults to `false` and is not inferred; the
  setting is documented as a statement about network topology in
  `docs/security/tls-enforcement.md` (Issue 213). The redirect itself is
  implemented in `apps/api/src/plugins/security-headers.ts`.
- **Verification:** `tests/integration/security-headers.spec.ts` — "ignores a
  forged X-Forwarded-Proto when no proxy is trusted", "does not redirect an
  https request the proxy reported".
- **Status:** mitigated
- **Residual risk:** An operator who enables `TRUST_PROXY` on a directly
  exposed process re-opens this by configuration. The default is safe; the knob
  cannot enforce itself.

#### INFRA-S-2: Attacker-controlled browser origin reading authenticated responses

- **STRIDE category:** Spoofing
- **Actor:** Hostile web page the victim visits
- **Entry point:** Any route, with an `Origin` header the victim's browser
  attaches
- **Asset:** Responses readable by a cross-origin page, and any authenticated
  call such a page can make
- **Description:** Without an explicit policy, a page at `evil.example` makes
  the victim's browser call this API and read the response. With a permissive
  policy (`*`, or a suffix match), a lookalike domain gets the same access as a
  legitimate front end.
- **Impact:** Cross-origin data read; with credentials, actions as the victim.
- **Mitigation:** Explicit allowlist with exact-origin matching; non-allowlisted
  origins refused with `403`; credentials off by default; wildcard-with-
  credentials refused at startup (Issue 204 in this phase,
  `apps/api/src/plugins/cors.ts`, `@verixa/config`).
- **Verification:** `tests/integration/cors.spec.ts` — "rejects a request from an
  origin that is not on the allowlist", "refuses a suffix lookalike",
  "allows the wildcard only while credentials are off";
  `packages/config/index.spec.ts` — wildcard-with-credentials refusal.
- **Status:** mitigated
- **Residual risk:** An origin on the allowlist that is itself compromised is
  indistinguishable from a legitimate one. CORS is a boundary between origins,
  not a statement about their trustworthiness.

### Tampering

#### INFRA-T-1: Known-vulnerable or hostile dependency

- **STRIDE category:** Tampering
- **Actor:** Registry/ecosystem attacker; opportunistic exploitation of a
  published advisory
- **Entry point:** `pnpm-lock.yaml` → installed packages → the process at
  runtime
- **Asset:** Everything the process can reach: tokens, database, audit history
- **Description:** A dependency version with a known high or critical advisory
  is shipped and exploited. A take-over of a package maintainer publishes a
  malicious version that nobody reviews, and code executes with full process
  privileges.
- **Impact:** Depending on the package: RCE, data exfiltration, quiet modification
  of audit records.
- **Mitigation:** Every PR and a nightly scan fail on unexcepted high/critical
  advisories in production dependencies, with a maintained, dated exception
  process (Issue 207, `.github/workflows/dependency-scan.yml`,
  `infra/ci/security-exceptions.json`); the lockfile is committed and checked
  against every manifest, and an SBOM is generated per release (Issue 215).
- **Verification:** `tests/ci/dependency-scan.spec.ts` — the gate fires on the
  intentionally vulnerable fixture and honours an unexpired exception;
  `tests/ci/lockfile-integrity.spec.ts` — the lockfile gate.
- **Status:** mitigated
- **Residual risk:** An advisory has to exist before it is found. A freshly
  published malicious version with no advisory is not caught by either control —
  tracked as INFRA-T-3.

#### INFRA-T-2: Unsafe pattern reaching the codebase through review

- **STRIDE category:** Tampering
- **Actor:** A contributor acting in good faith, or a review that missed a line
- **Entry point:** Any pull request
- **Asset:** Whatever the unsafe pattern can reach — `eval`, a child process, a
  file path, a regex engine
- **Description:** `eval(userInput)`, `exec(userInput)`, a non-literal `fs`
  path, a catastrophic regex, a weak random source. Each is one line, each
  passes a review that is reading for intent, and each is the entry point of a
  vulnerability class this model otherwise assumes away.
- **Impact:** A new, avoidable vulnerability class in a codebase whose other
  controls assume it does not exist.
- **Mitigation:** `eslint-plugin-security` tuned to a shared ruleset; the
  low-noise classes are errors in the existing lint job (Issue 208,
  `infra/ci/security-lint-rules.mjs`).
- **Verification:** `tests/ci/security-lint.spec.ts` — every enabled rule fires
  on a deliberately vulnerable fixture; `pnpm lint` runs the same ruleset in CI.
- **Status:** mitigated
- **Residual risk:** Pattern matching, not dataflow. A value that reaches a sink
  through a helper is not followed; the injection review (Issue 210) and the pen
  test (Issue 217) cover that class.

#### INFRA-T-3: Build or release chain tampering with no advisory to catch it

- **STRIDE category:** Tampering
- **Actor:** Registry/ecosystem attacker; anyone able to compromise a CI
  dependency or a runner
- **Entry point:** CI workflow, a lockfile resolution, or an action pinned to a
  mutable tag
- **Asset:** The release artifact — the image and the SBOM downstream users rely
  on
- **Description:** A malicious package version without a published advisory, a
  compromised GitHub Action, or a build step that produces an artifact different
  from the reviewed source. There is no signature to check and no advisory to
  match.
- **Impact:** A widely deployed artifact that contains code no reviewer saw.
- **Mitigation:** None complete. The lockfile gate and SBOM (Issue 215) make the
  graph reviewable and reproducible; actions are pinned to major versions and
  the workflow set is small.
- **Verification:** none for the provenance property itself. The SBOM tests
  (`tests/ci/sbom.spec.ts`) verify the inventory is complete and stable, which
  is a precondition for provenance, not provenance.
- **Status:** accepted-risk
- **Residual risk:** The repository trusts the npm registry's publish
  authentication and GitHub's runner integrity. Signed builds, provenance
  attestations (SLSA-style) and digest-pinned actions would reduce this and are
  not in Phase 11. The acceptance is time-bounded: it is defensible while the
  project has no production deployment, and should be revisited before one.

### Repudiation

#### INFRA-R-1: Infrastructure events that leave no attributable record

- **STRIDE category:** Repudiation
- **Actor:** Authenticated user or compromised process
- **Entry point:** Process lifecycle, configuration load, container start
- **Asset:** The audit record's completeness
- **Description:** A configuration change, a process restart or a failed
  deployment is not necessarily recorded anywhere a security review can read. If
  the deployment had a materially different security posture for a window, no
  record shows it.
- **Impact:** An incident cannot be scoped: it is impossible to say from the
  audit log alone which posture was live at what time.
- **Mitigation:** Partially covered by the audit context's integrity work
  (Issue 195, `docs/security/audit-log-integrity.md`) and the incident-response
  runbook (Issue 218). Deployment-time posture logging is not implemented.
- **Verification:** none for the posture-history property; the runbook records
  the manual process.
- **Status:** open
- **Residual risk:** Until it lands, incident scoping depends on CI run history
  and operator memory.

### Information disclosure

#### INFRA-I-1: Eavesdropping on the transport

- **STRIDE category:** Information disclosure
- **Actor:** Network attacker on the path
- **Entry point:** The client-to-proxy network path; any plaintext listener
- **Asset:** Session cookies, bearer tokens, credentials, verification and reset
  tokens
- **Description:** Strip or avoid TLS and read the requests. Or connect directly
  to a plaintext listener an operator left reachable, bypassing the proxy's
  redirect.
- **Impact:** Full account takeover from a single captured request; bulk
  compromise if the path is used by many clients.
- **Mitigation:** The required TLS-termination point, HSTS with
  `includeSubDomains`, an optional 308 plaintext redirect, and a validated
  `Host` before any redirect target is built (Issue 213,
  `apps/api/src/plugins/security-headers.ts`,
  `docs/security/tls-enforcement.md`). Local development is an explicit,
  documented exception rather than a silent one.
- **Verification:** `tests/integration/security-headers.spec.ts` — HSTS value,
  the 308 preserving method and body, `no-store` on the redirect;
  `apps/api/src/plugins/security-headers.spec.ts` — `Host` validation.
- **Status:** mitigated
- **Residual risk:** Certificate lifecycle, TLS version and cipher policy belong
  to the terminator and are not enforced by this process. A deployment that
  terminates TLS badly is not caught here.

#### INFRA-I-2: Fingerprinting through response metadata

- **STRIDE category:** Information disclosure
- **Actor:** Unauthenticated internet client
- **Entry point:** Any response
- **Asset:** Knowledge of the stack, used to select the right exploit
- **Description:** `X-Powered-By` and an unfiltered default header set name the
  framework and version before an attacker has probed anything.
- **Impact:** Cheaper targeting; not a compromise on its own.
- **Mitigation:** A single global header policy registered before any route,
  including `hidePoweredBy` (Issue 203,
  `docs/security/http-security-headers.md`).
- **Verification:** `apps/api/src/plugins/security-headers.spec.ts` — "does not
  advertise the stack"; `tests/integration/security-headers.spec.ts`.
- **Status:** mitigated
- **Residual risk:** Detail still leaks through timings, error shapes and
  ecosystem-specific headers a proxy adds. Deliberate low impact.

#### INFRA-I-3: Process compromise exposing secrets from the environment

- **STRIDE category:** Information disclosure
- **Actor:** Attacker who has achieved code execution in the process (through a
  dependency, a route bug, or an operator mistake)
- **Entry point:** Process memory and `process.env`
- **Asset:** Database and Redis credentials, `SESSION_ACCESS_TOKEN_SECRET`,
  signing keys, MFA encryption key
- **Description:** The process holds every secret it needs in plain form, by
  necessity. Code execution in it reads them all, and the process's own database
  credentials are likely the most valuable single item.
- **Impact:** Persistence beyond the process: forged tokens, database read/write,
  audit tampering.
- **Mitigation:** Partial. Secrets have no shared defaults and are validated at
  startup; unexpected error details are never returned to a caller
  (`apps/api/src/http/error-response.ts`). Least-privilege database roles are in
  place (row-level security is enforced; see
  `docs/security/multi-tenancy.md`). A secret manager, short-lived credentials
  and rotation procedures are Issue 206.
- **Verification:** `packages/config/index.spec.ts` — required secrets with no
  default; `apps/api/src/http/error-response.spec.ts` — sanitized 500s.
- **Status:** open
- **Residual risk:** Everything above reduces blast radius; none of it prevents a
  process with code execution from reading its own environment. The honest
  control is minimizing what the process can reach (least privilege) and
  detecting the compromise (Issue 218).

### Denial of service

#### INFRA-D-1: Unthrottled credential-adjacent endpoints

- **STRIDE category:** Denial of service
- **Actor:** Unauthenticated internet client, possibly distributed
- **Entry point:** `POST /auth/login`, MFA verification, password-reset
  confirmation, API-key validation
- **Asset:** Availability; and, through lockout, legitimate users' access
- **Description:** Flood a verification endpoint. Either the work is cheap and
  the service is hammered, or lockout is triggered deliberately to deny access
  to real users — the control becomes the attack.
- **Impact:** Service degradation; targeted account denial of service.
- **Mitigation:** Per-account lockout exists in the credentials context. A
  generalized `BruteForcePolicy` across endpoints, composed with the rate-limiter
  port, is Issue 209 (implementation in Phase 15). Not yet wired.
- **Verification:** none for the general policy; `authenticate-with-password-
lockout.spec.ts` covers the login-account case only.
- **Status:** open
- **Residual risk:** An edge/WAF rate limit is the practical mitigation for the
  network-flood half and is not configured here.

#### INFRA-D-2: Resource exhaustion from large or slow requests

- **STRIDE category:** Denial of service
- **Actor:** Unauthenticated internet client
- **Entry point:** Any route; a slow or oversized request body
- **Asset:** Process memory and event-loop availability
- **Description:** Hold connections open, or send a body larger than any
  legitimate caller would. Node's per-request overhead makes this cheap for the
  attacker and expensive for the server.
- **Impact:** The single process stops serving every tenant.
- **Mitigation:** Partial. JSON body limits are Fastify's, and upload handling
  checks a size threshold (`apps/api/src/routes/verification.ts`). Timeouts,
  concurrency limits and buffering policy are proxy/runtime configuration and
  are not tuned or documented as a posture.
- **Verification:** none for the limits themselves.
- **Status:** open
- **Residual risk:** Accepted for now because no production deployment exists;
  the deployment checklist should make body size, header size and idle timeouts
  an explicit proxy decision.

### Elevation of privilege

#### INFRA-E-1: Container escape through a misconfigured runtime

- **STRIDE category:** Elevation of privilege
- **Actor:** Attacker with code execution in the container
- **Entry point:** Container runtime: image user, capabilities, filesystem,
  mounted sockets
- **Asset:** The host and every other workload on it
- **Description:** A privileged container, a root user, a writable root
  filesystem, or a mounted container-runtime socket turns container compromise
  into host compromise. The application cannot prevent this; only the image and
  the runtime flags can.
- **Impact:** Full host compromise, cross-tenant in a shared cluster.
- **Mitigation:** Multi-stage build with a non-root runtime user, minimal
  runtime image without dev dependencies or source maps (Issue 216,
  `docs/security/container-hardening.md`); the image's OS packages are scanned
  and high/critical findings fail CI
  (`.github/workflows/container-scan.yml`).
- **Verification:** `.github/workflows/container-scan.yml` fails on a
  high/critical OS package finding; the build-and-run job in `ci.yml` proves the
  image starts as the non-root user.
- **Status:** mitigated
- **Residual risk:** Runtime flags (`--privileged`, host mounts, added
  capabilities) are outside this repository. The image is safe to run; it cannot
  stop a deployment from running it unsafely.

#### INFRA-E-2: Cross-service privilege through an unconfigured seam

- **STRIDE category:** Elevation of privilege
- **Actor:** Attacker who reaches one component of a future multi-service
  deployment
- **Entry point:** The HTTP or message-network boundary between services defined
  by ARCHITECTURE.md §7
- **Asset:** Other components' data and privileges
- **Description:** Today everything is one process, so "calling another service"
  is a function call with the caller's own authorization. The day a seam becomes
  a network boundary, a component that trusted its caller by assumption grants
  whatever the caller asks for.
- **Impact:** After a split, cross-context privilege escalation — the exact
  failure the bounded-context design exists to prevent.
- **Mitigation:** None yet, by construction: there is no inter-service network
  boundary to secure. The design constraint is recorded so the first split
  inherits an explicit authentication and authorization requirement rather than
  an assumption.
- **Verification:** none; there is no boundary to test.
- **Status:** accepted-risk
- **Residual risk:** The risk is entirely latent. The acceptance is conditional:
  it holds only while the deployment is a single process, and the first
  service split must replace it with mutual authentication, per-call
  authorization and an explicit trust boundary threat model.

## Accepted risks

**INFRA-T-3 — build and release chain tampering.** Accepted because the project
has no production deployment and downstream users build from source, which makes
the provenance gap narrower than it will be later. The compensating controls
(committed lockfile, verified lockfile integrity, SBOM per release, actions
pinned to major versions, a small workflow set) make the graph reviewable and
reproducible. This acceptance should be re-examined before the first production
deployment, and signed builds or provenance attestations are the expected fix.

**INFRA-E-2 — cross-service privilege through an unconfigured seam.** Accepted
because the seam is a design intent, not a deployed boundary: one process means
there is no network call to intercept and no second credential to steal. The
acceptance is explicitly conditional on the monolith. The first service split
must add mutual authentication between services, per-call authorization, and a
trust-boundary threat model covering the new network path.

## Related documentation

- [Threat Register](threat-register.md) — every `INFRA` row with status, indexed
  with the per-context threats.
- [Threat Model Template](threat-model-template.md) — the format and the status
  definitions this document follows.
- [Threat Model: Credentials](threat-model-credentials.md) — what happens after a
  request authenticates.
- [Threat Model: Audit Logging](threat-model-audit.md) — the asset most exposed
  to a process compromise.
- [TLS Enforcement & HSTS](tls-enforcement.md) — the transport posture
  INFRA-I-1 depends on.
- [HTTP Security Headers](http-security-headers.md) — Issues 203/212.
- [CORS Policy](cors-policy.md) — Issue 204.
- [Dependency Scanning](dependency-scanning.md) — Issue 207.
- [Static Analysis](static-analysis.md) — Issue 208.
- [Container Hardening](container-hardening.md) — Issue 216.
- [Incident Response Runbook](incident-response-runbook.md) — what happens after
  one of these is detected.
