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
