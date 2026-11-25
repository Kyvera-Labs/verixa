# Rate Limiting & Abuse Prevention

This guide explains the design, algorithms, storage mechanics, route policies, and allowlist architectures powering Verixa's rate-limiting infrastructure (Phase 15).

Verixa is designed as an educational, production-grade identity and authorization platform. The code prioritizes clear architectural boundaries, strict type safety, predictable operational behavior, and explicit security models.

---

## 1. Architectural Overview

Rate limiting in Verixa is structured in distinct layers following the platform's domain-driven architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                       HTTP / API Layer                      │
│   (Route resolution, IP / token extraction, allowlist check) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      Application Layer                      │
│   - RoutePolicyRegistry (per-route configuration)           │
│   - RateLimitAllowlist (CIDR & service token bypasses)      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  Domain / Storage Layer                     │
│   - TokenBucket (pure in-memory algorithm primitive)        │
│   - RedisBucketStore (distributed atomic Lua store)         │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Token Bucket Algorithm (Issue 313)

### Why Token Bucket?

When rate-limiting an API, three classical algorithm families are typically considered:

1. **Fixed-Window Counter**:
   - _Mechanism_: Tracks request count in fixed temporal windows (e.g. 12:00:00 to 12:01:00).
   - _Flaw (The Boundary Burst)_: An attacker can send the entire quota at 12:00:59 and another quota at 12:01:01, effectively delivering 2x the allowed limit in 2 seconds.

2. **Sliding-Window Log**:
   - _Mechanism_: Stores timestamps of every request in a sorted set (ZSET) and counts entries within `[now - window, now]`.
   - _Flaw (Memory Footprint)_: Under high traffic or DDoS attacks, storing every request timestamp consumes excessive memory ($O(N)$ space where $N$ is total requests).

3. **Token Bucket (Verixa's Choice)**:
   - _Mechanism_: A bucket has a fixed `capacity` of tokens. Tokens replenish continuously at a steady rate of `refillRatePerSecond`.
   - _Benefit_: Naturally tolerates legitimate bursts up to `capacity` (e.g. initial page loads requesting several assets in parallel), while enforcing a strict mathematical asymptote on sustained throughput (`refillRatePerSecond`).
   - _Storage_: Requires only two numeric values: `tokens` and `lastRefillTimestamp` ($O(1)$ constant memory).

### Mathematical Mechanics

Given:

- $C$: maximum bucket capacity
- $r$: refill rate in tokens per second
- $t_{\text{now}}$: current timestamp (milliseconds)
- $t_{\text{last}}$: previous refill timestamp (milliseconds)
- $T_{\text{prev}}$: available tokens at $t_{\text{last}}$

The refilled tokens are computed proportionally:

$$\Delta t = \max(0, t_{\text{now}} - t_{\text{last}})$$

$$T_{\text{current}} = \min(C, T_{\text{prev}} + \frac{\Delta t}{1000} \times r)$$

If $T_{\text{current}} \ge \text{requested}$:

- Consumption succeeds: $T_{\text{remaining}} = T_{\text{current}} - \text{requested}$
- Next token wait time: $\text{timeToNext} = \lceil \frac{1 - (T_{\text{remaining}} \bmod 1)}{r} \times 1000 \rceil$

If $T_{\text{current}} < \text{requested}$:

- Consumption fails: request denied.
- Deficit wait time: $\text{timeToNext} = \lceil \frac{\text{requested} - T_{\text{current}}}{r} \times 1000 \rceil$

---

## 3. Distributed Consistency with Redis & Lua Scripting (Issue 314)

### The Read-Modify-Write Concurrency Race

In a horizontally scaled deployment with multiple `apps/api` worker processes, a naive distributed implementation using separate Redis commands (`GET`, followed by calculation, followed by `SET`) introduces severe race conditions:

```
Client A (Worker 1)          Redis                Client B (Worker 2)
      │                        │                           │
      ├────── GET key ────────►│                           │
      │   (tokens = 1)         │◄────── GET key ───────────┤
      │                        │     (tokens = 1)          │
      │  Calculates: 1 - 1 = 0 │                           │
      │                        │    Calculates: 1 - 1 = 0  │
      ├────── SET key 0 ──────►│                           │
      │   (Allowed: TRUE)      │◄────── SET key 0 ─────────┤
      │                        │     (Allowed: TRUE)       │
                                    ▲ OVER-GRANTED!
```

Both workers saw 1 token and granted the request, yielding 2 granted requests when only 1 token was available. Using distributed locks (e.g. Redlock) introduces significant network round-trip latency (at least 2 extra roundtrips per request) and complex failure modes.

### The Lua Script Solution

Redis executes Lua scripts atomically in a single event-loop cycle without yielding to other commands. Verixa's `infrastructure/lua/consume-bucket.lua` runs the entire read-refill-consume sequence atomically in one round-trip:

1. Retrieves `tokens` and `last_refill` via `HMGET`.
2. Computes proportional token refill based on `now_ms - last_refill`.
3. Checks whether available tokens cover `requested_tokens`.
4. Updates the hash with `HMSET` and sets the idle expiration with `EXPIRE`.
5. Returns `[allowed, remainingTokens, timeToNextTokenMs]`.

### Key Schema and TTL Policy

- **Key Format**: `ratelimit:{scope}:{key}`
  - Example: `ratelimit:login:192.168.1.10`
  - Example: `ratelimit:register:user@example.com`
- **Automatic Key Expiration**:
  To prevent unconstrained key growth from one-off callers or rotating botnet IP addresses, keys expire automatically when idle:
  $$\text{TTL} = \max(\text{defaultTtl}, \lceil \frac{C}{r} \times 2 \rceil + 60 \text{ seconds})$$
  Once the bucket has sat idle long enough to reach maximum capacity, the key is evicted by Redis. Any subsequent request begins fresh at full capacity, matching the mathematical behavior of an in-memory bucket.

---

## 4. Per-Route Policy Configuration (Issue 315)

### Why Uniform Rate Limits Fail

Applying uniform rate limits across all routes creates a dangerous trade-off:

- If the global limit is set high enough for read-heavy browsing (e.g., 60 requests/minute), authentication endpoints remain vulnerable to automated password spraying and credential stuffing.
- If the global limit is set low enough to protect login (e.g., 5 requests/minute), legitimate user interactions on the dashboard or search endpoints trigger false-positive rate-limit errors.

Verixa enforces distinct policies per endpoint sensitivity:

| Route / Scope               | Burst Capacity | Refill Rate         | Window Duration | Rationale                                                                           |
| :-------------------------- | :------------- | :------------------ | :-------------- | :---------------------------------------------------------------------------------- |
| **`login`**                 | 5              | 5 / 60 s (~0.083/s) | 60 seconds      | Strictest protection against credential stuffing and brute-force password guessing. |
| **`register`**              | 3              | 3 / 60 s (0.05/s)   | 60 seconds      | High friction to prevent automated bot account creation and database bloat.         |
| **`password-reset`**        | 3              | 3 / 60 s (0.05/s)   | 60 seconds      | Mitigates email-bombing vectors and reset token generation spam.                    |
| **`default` (General API)** | 60             | 1 token/s           | 60 seconds      | Balanced default for standard authenticated and unauthenticated queries.            |

### Fail-Fast Configuration Validation

All route policy objects are strictly validated at startup using Zod (`routePolicyConfigSchema`). Misconfigurations such as negative limits, zero refill rates, or windows shorter than 1000ms fail fast at server boot, preventing invalid policies from silently running in production.

---

## 5. Trusted Source Allowlist & Bypass Auditing (Issue 304)

### The Privilege Escalation Risk

Internal health probes (e.g., Kubernetes liveness probes), monitoring agents, and CI smoke tests poll endpoints rapidly. If rate-limited, false alerts trigger downtime procedures. However, allowlists are a primary target for privilege escalation:

- If an allowlist silently ignores traffic, an attacker who spoofed an internal IP or obtained an internal token could abuse the service without leaving traces.
- Overly broad CIDR ranges (e.g., `0.0.0.0/0`) could accidentally neutralize rate limiting entirely.

### Verixa's Allowlist Rules

The `RateLimitAllowlist` supports:

1. **Exact IP addresses**: IPv4 (`127.0.0.1`) and IPv6 (`::1`).
2. **CIDR Subnets**:
   - IPv4 CIDR blocks (e.g., `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
   - IPv6 CIDR blocks (e.g., `fe80::/10`, `::1/128`).
3. **Service-Account Bearer Tokens**:
   - Trusted service-to-service header tokens (e.g., `Bearer internal-metrics-agent`).

### Audit Logging: Never Silent

Every allowlist bypass produces a structured `AllowlistBypassEvent` recorded by the application logger:

```json
{
  "level": "info",
  "msg": "Rate limit bypassed for allowlisted cidr: 10.1.2.3 (matched 10.0.0.0/8)",
  "bypassEvent": {
    "subject": "10.1.2.3",
    "matchType": "cidr",
    "matchedRule": "10.0.0.0/8",
    "timestamp": "2026-11-21T20:30:00.000Z",
    "path": "/health"
  }
}
```

This guarantees security observability: security operations can immediately identify if an unauthorized client attempts to route traffic through an allowlisted CIDR or if an internal service token is leaked.

---

## 6. Operational Configuration & Composition Wiring (Issue 297)

### Composition Root Wiring

The Phase 15 rate limiting subsystem is wired centrally in `apps/api/src/composition-root.ts` and registered into the HTTP pipeline in `apps/api/src/app.ts`:

1. **Dependency Injection**:
   - `buildContainer()` instantiates `ProductionCredentialRateLimiter` (or `NoopRateLimiter` when `NODE_ENV === "test"` or injected via `ContainerOverrides`).
   - The limiter instance is wired into all credential, session, and MFA use cases (`AuthenticateWithPassword`, `RegisterUserWithPassword`, `RequestPasswordReset`, `ConfirmPasswordReset`, `RefreshAccessToken`, `VerifyTotpChallenge`, `ConsumeBackupCode`).
2. **Fastify Plugin Registration**:
   - `buildApp()` automatically registers the `registerRateLimit` plugin on the Fastify instance in all non-test environments (or when explicitly requested via `rateLimit` options).
   - The plugin attaches an `onRequest` pre-handler hook that calculates keys based on client IP, authenticated user ID, or API key, applies route-specific policies, and injects IETF-compliant rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`).

### Environment Variables Matrix

| Environment Variable                  | Default Value            | Description                                                                                                       |
| :------------------------------------ | :----------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                           | `redis://localhost:6379` | Redis instance URL used by `RedisBucketStore` and the sliding window rate limiter store.                          |
| `RATE_LIMIT_DEFAULT_MAX`              | `100`                    | Global default maximum requests per window for unconfigured routes.                                               |
| `RATE_LIMIT_DEFAULT_WINDOW_MS`        | `60000`                  | Global default time window in milliseconds (1 minute).                                                            |
| `RATE_LIMIT_ALLOWLIST_IPS`            | `127.0.0.1,::1`          | Comma-delimited list of trusted IPv4/IPv6 addresses or CIDR blocks exempt from rate limiting.                     |
| `RATE_LIMIT_ALLOWLIST_SERVICE_TOKENS` | _(empty)_                | Comma-delimited list of trusted internal bearer tokens exempt from rate limiting.                                 |
| `CAPTCHA_FAILURE_THRESHOLD`           | `3`                      | Number of credential verification failures within a sliding window before requiring CAPTCHA challenge resolution. |

### Operational Runbook

1. **Monitoring Throttle Rates**:
   - Monitor `RATE_LIMITED` (HTTP 429) metric counters in log aggregators. Spikes across diverse IPs indicate distributed credential attacks; spikes from single IPs indicate misconfigured clients or localized brute-force attempts.
2. **Redis Outage Degradation**:
   - If Redis becomes unreachable, `RateLimiterStore` automatically degrades to the in-memory fallback store on each process instance. This prevents an external cache failure from causing full API downtime while preserving local defense.
3. **Emergency Allowlisting**:
   - In the event that a critical external partner or integration proxy is throttled during traffic bursts, add their CIDR block or service token to `RATE_LIMIT_ALLOWLIST_IPS` / `RATE_LIMIT_ALLOWLIST_SERVICE_TOKENS` and restart or reload the service. All bypasses are recorded in the audit trail.

# Rate Limiting Guide

This guide describes Verixa's rate-limiting architecture, strategy selection rules, threat models, and integration patterns across sensitive endpoints such as authentication, password resets, registration, and administrative operations.
This guide details Verixa's rate-limiting architecture, strategy selection, standard HTTP response headers, and client back-off protocols across sensitive endpoints.

---

## Architecture Overview

Rate limiting in Verixa is structured into layered, composable components:

1. **Storage Ports (`RateLimiter`)**: Low-level sliding-window or token-bucket counter storage (e.g. Redis, in-memory) defined in `@verixa/shared-kernel`.
2. **Specialized Strategies**: Dimension-specific domain logic for resolving identities, validating keys, and managing quotas:
   - `IpRateLimitStrategy`: Governs limits keyed to client IP addresses.
   - `AccountRateLimitStrategy`: Governs limits keyed to account identifiers (emails, usernames).
   - `CompositeRateLimitStrategy`: Combines multiple dimensions in defense-in-depth policies.
3. **HTTP Integration Layer**: Route hooks and middleware that evaluate strategies and emit standard rate-limiting response headers.

---

## Strategy Selection

Choosing the correct rate-limiting strategy depends on the specific threat vector and endpoint sensitivity.

| Strategy                                       | Primary Threat Vector                                                                     | Weakness When Used Alone                                                                                                        | Recommended Endpoints                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **IP-Based** (`IpRateLimitStrategy`)           | Volumetric DoS, single-origin API spam                                                    | Ineffective against distributed botnets / proxy rotation; risks noisy-neighbor throttling behind shared NAT/corporate gateways. | Public unauthenticated reads, health checks, search endpoints, initial static assets.           |
| **Account-Based** (`AccountRateLimitStrategy`) | Distributed credential stuffing, password spray against targeted accounts                 | Ineffective against account-enumeration scans cycling through millions of distinct account names from a single IP.              | Authenticated operations, targeted password resets, account unlocks.                            |
| **Composite** (`CompositeRateLimitStrategy`)   | Multi-vector abuse: botnets hitting single accounts AND single IPs spraying many accounts | Higher resource consumption (evaluates both buckets).                                                                           | Sensitive authentication entrypoints (`/auth/login`, `/auth/register`, `/auth/reset-password`). |

---

## Why Composite Limiting (Defense in Depth)?

In modern web security, **no single dimension is sufficient alone**:

### Attack Scenario 1: Distributed Credential Stuffing (Botnet)

An attacker controls 50,000 residential proxy IPs. Each proxy IP sends only 1 login request per hour targeting a single victim account (`alice@example.com`).

- **IP-only strategy**: Sees 1 request per IP per hour. Completely fails to detect or throttle the attack.
- **Account strategy in Composite**: Tracks attempts on `account:alice@example.com`. Once the account threshold is reached, further attempts are blocked regardless of the attacking IP.

### Attack Scenario 2: Account Enumeration and Spraying

An attacker uses a single host (or small cluster) to test 100,000 distinct usernames against a common password dictionary.

- **Account-only strategy**: Sees only 1 attempt per username. Fails to throttle the attack because every request uses a different account key.
- **IP strategy in Composite**: Tracks requests from the attacking IP. After exceeding the IP threshold, the attacker is blocked from testing additional accounts.

### Judgment Call: Decision Combination Logic

When combining sub-strategies in `CompositeRateLimitStrategy`:

- **Accepted Rule (Strictest Wins)**: If _either_ IP or account strategy denies the request, the composite strategy denies (`allowed = false`).
- **Rejected Alternative (Weighted Scoring / Threshold Summation)**: Summing denial probabilities or assigning weights was rejected because authentication security requires deterministic guarantees: an account undergoing brute force must be shielded even if the IP appears innocent, and an abusive IP must be throttled even if it targets a non-existent account.
- **Auditing Visibility**: The result explicitly annotates `deniedBy` (`"ip" | "account" | "both"`) so security teams and audit logs can distinguish distributed stuffing attacks from localized volumetric abuse without exposing internal state to the untrusted caller.
  Rate limiting in Verixa is structured into layered components:

1. **Storage Ports (`RateLimiter`)**: Defined in `@verixa/shared-kernel`, providing sliding-window or token-bucket counter persistence.
2. **Specialized Strategies (`@verixa/rate-limiting`)**:
   - `IpRateLimitStrategy`: Governs limits keyed to client IP addresses with reverse-proxy spoofing protection.
   - `AccountRateLimitStrategy`: Governs limits keyed to account identifiers (emails, usernames).
   - `CompositeRateLimitStrategy`: Multi-dimensional defense-in-depth policy combining IP and account dimensions.
3. **HTTP Header Middleware (`@verixa/api`)**: Fastify hooks that evaluate quotas and emit standard response headers.

---

## HTTP Rate-Limit Response Headers

Rate-limited endpoints communicate bucket status to clients on every evaluated response using standard headers:

| Header                  | Present On                       | Value Format                                   | Description                                                                       |
| ----------------------- | -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | All rate-limited routes          | Integer (e.g. `100`)                           | The total request quota allocated to the client/principal in the current window.  |
| `X-RateLimit-Remaining` | All rate-limited routes          | Integer (e.g. `42`)                            | The number of remaining allowed requests before throttling occurs in this window. |
| `X-RateLimit-Reset`     | All rate-limited routes          | Integer Unix epoch seconds (e.g. `1700000030`) | Wall-clock timestamp when the current rate limit window resets.                   |
| `Retry-After`           | **429 (Too Many Requests)** only | Integer delta seconds (e.g. `30`)              | Minimum number of seconds the client must wait before retrying.                   |

---

## Why Standard Headers Reduce Retry Storms (IETF Conventions)

When APIs throttle requests without returning structured back-off parameters, automated clients resort to blind polling or aggressive retry loops. This frequently triggers **retry storms**, where clients retry simultaneously at fixed intervals, amplifying the load and turning a localized spike into a full cascading outage.

### Standardized Back-Off Signals

Emitting `X-RateLimit-*` and `Retry-After` establishes a clear contract:

1. **Predictable Client Throttling**: Clients and SDKs can pace their outbound requests before consuming their final remaining quota.
2. **Deterministic Back-Off**: On receiving HTTP 429, well-behaved clients read `Retry-After` (in seconds) and delay retries according to the server's exact schedule plus jitter, avoiding synchronized thunder-herd spikes.
3. **Observability**: Proxies, gateways, and monitoring dashboards can detect quota exhaustion early from HTTP responses without inspecting application logs or response payloads.

---

## Judgment Calls and Design Decisions

### 1. `X-RateLimit-*` vs Draft IETF `RateLimit-*` Headers

- **Accepted**: Emit the established de facto standard headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) along with RFC 9110 standard `Retry-After`.
- **Rejected Alternative**: Adopting the draft `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` specification exclusively was rejected because widespread HTTP client libraries, API gateways, SDKs, and developer tooling (Postman, curl scripts, third-party monitoring) expect `X-RateLimit-*`. Once the IETF specification reaches final RFC status and ecosystem ubiquity, dual-header emission can be phased in without breaking existing clients.

### 2. Seconds vs Milliseconds for `Retry-After`

- **Accepted**: Delta seconds rounded up (`Math.ceil((resetAt - now) / 1000)`), with a hard floor of `1` second.
- **Rejected Alternative**: Millisecond resolution or fractional numbers. RFC 9110 Section 10.2.3 explicitly requires `Retry-After` to be a non-negative decimal integer representing seconds (or an HTTP-date). Using fractional seconds or milliseconds breaks HTTP client parsers.

### 3. Presence of `Retry-After` on Successful (200) Requests

- **Accepted**: Omit `Retry-After` on successful responses (`200 OK`).
- **Rejected Alternative**: Emitting `Retry-After: 0` on 200 responses. Some HTTP proxies misinterpret `Retry-After` on non-429/503 responses as an indicator of service degradation or cache invalidation. `Retry-After` is strictly reserved for throttle and back-off responses.
