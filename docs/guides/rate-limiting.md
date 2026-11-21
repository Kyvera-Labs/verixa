# Rate Limiting & Abuse Prevention Guide

This guide details Verixa's rate-limiting architecture, strategy selection, CAPTCHA escalation triggers, anomaly detection heuristics, and standard HTTP back-off headers.

---

## Architecture Overview

Rate limiting in Verixa is structured into layered components:

1. **Storage Ports (`RateLimiter`)**: Port in `@verixa/shared-kernel` backed by production sliding-window/token-bucket stores.
2. **Dimension-Specific Strategies (`@verixa/rate-limiting`)**:
   - `IpRateLimitStrategy`: Governs limits keyed to client IP addresses with reverse-proxy spoofing protection.
   - `AccountRateLimitStrategy`: Governs limits keyed to account identifiers (emails, usernames).
   - `CompositeRateLimitStrategy`: Multi-dimensional defense-in-depth policy combining IP and account dimensions.
3. **Adaptive Friction (`CaptchaTriggerPolicy`)**:
   - Escalates verification to a human-challenge CAPTCHA (`CaptchaVerifier`) after consecutive failures before hard account lockout.
4. **Behavioral Anomaly Detection (`@verixa/rate-limiting`)**:
   - `ImpossibleTravelDetector`: Flags geographically distant logins occurring in implausibly short timeframes.
   - `VolumeAnomalyDetector`: Flags sudden multi-x volume spikes relative to a subject's rolling baseline.
5. **HTTP Middleware & Response Headers (`@verixa/api`)**:
   - Injects standard `X-RateLimit-*` and `Retry-After` headers and handles 429 status codes.

---

## Strategy Selection

Choosing the correct strategy depends on the endpoint sensitivity and threat model:

| Strategy                                       | Primary Threat Vector                                                                     | Weakness When Used Alone                                                                                       | Recommended Endpoints                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **IP-Based** (`IpRateLimitStrategy`)           | Volumetric DoS, single-origin API spam                                                    | Ineffective against distributed botnets / proxy rotation; risks noisy-neighbor throttling behind shared NAT.   | Public unauthenticated reads, health checks, search endpoints.                                  |
| **Account-Based** (`AccountRateLimitStrategy`) | Distributed credential stuffing, password spray against targeted accounts                 | Ineffective against account-enumeration scans cycling through millions of distinct usernames from a single IP. | Authenticated operations, targeted password resets, account unlocks.                            |
| **Composite** (`CompositeRateLimitStrategy`)   | Multi-vector abuse: botnets hitting single accounts AND single IPs spraying many accounts | Evaluates both dimensions (slightly higher storage overhead).                                                  | Sensitive authentication entrypoints (`/auth/login`, `/auth/register`, `/auth/reset-password`). |

---

## CAPTCHA Verification Port & Trigger Policy

### CAPTCHA as Adaptive Friction

In Verixa, **CAPTCHA is treated as a stepped-up friction layer, not a primary defense**.

Forcing CAPTCHA widgets on every login or registration degrades user experience, accessibility, and automated testability. Instead, Verixa deploys `CaptchaTriggerPolicy`:

- **Trigger Threshold**: Monitored consecutive failures (default: 3 failures within 15 minutes) on either an account identifier or client IP trigger a challenge.
- **Seam Design**: `CaptchaVerifier` is a vendor-neutral port with a clean `verify(token): Promise<Result<void, CaptchaError>>` contract.
- **Interchangeability**: `NoopCaptchaVerifier` satisfies the port in local development and test environments, requiring zero external vendor API keys or network calls. In production, vendors like Cloudflare Turnstile, hCaptcha, or Google reCAPTCHA are swapped in at the composition root without touching domain logic.

---

## HTTP Rate-Limit Response Headers

Rate-limited endpoints communicate bucket status to clients on every evaluated response using standard headers:

| Header                  | Present On                       | Value Format                                   | Description                                                                   |
| ----------------------- | -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | All rate-limited routes          | Integer (e.g. `100`)                           | Total request quota allocated to the principal in the active window.          |
| `X-RateLimit-Remaining` | All rate-limited routes          | Integer (e.g. `42`)                            | Number of remaining allowed requests before throttling occurs in this window. |
| `X-RateLimit-Reset`     | All rate-limited routes          | Integer Unix epoch seconds (e.g. `1700000030`) | Wall-clock timestamp when the current rate limit window resets.               |
| `Retry-After`           | **429 (Too Many Requests)** only | Integer delta seconds (e.g. `30`)              | Minimum number of seconds the client must wait before retrying.               |

### Preventing Retry Storms (IETF Conventions)

When APIs throttle requests without returning structured back-off parameters, automated clients resort to blind polling or aggressive retry loops. This triggers **retry storms**, where clients retry simultaneously at fixed intervals, amplifying the load and turning a localized spike into a cascading outage.

Emitting `X-RateLimit-*` and RFC 9110 compliant integer `Retry-After` allows well-behaved clients and SDKs to pace their requests predictably and avoid synchronized thundering-herd retries.
