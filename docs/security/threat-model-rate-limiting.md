# Threat Model: Rate Limiting & Anomaly Detection

This document outlines Verixa's abuse threat model, risk scoring, and heuristic anomaly detection mechanisms across authentication and public API surfaces.

---

## Threat Vectors & Defenses

| Threat Vector                            | Mechanism                                                                          | Primary Defense                                                    | Anomaly Signal                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| **Distributed Credential Stuffing**      | Large botnet testing stolen credentials against single or targeted accounts.       | Account-keyed limiting (`AccountRateLimitStrategy`).               | Volume spike detection (`VolumeAnomalyDetector`).         |
| **Credential Spraying**                  | Single IP cycling through dictionary passwords across thousands of accounts.       | IP-keyed limiting (`IpRateLimitStrategy`) with proxy verification. | Multi-account volume anomaly.                             |
| **Account Takeover / Session Hijacking** | Attacker using stolen session or credentials from a geographically distant region. | MFA + Session binding.                                             | Impossible travel heuristic (`ImpossibleTravelDetector`). |
| **Slow-Drip Scraping & Probing**         | Low-frequency automated requests staying just below fixed rate limits.             | Sliding window limits.                                             | Rolling baseline deviation (`VolumeAnomalyDetector`).     |

---

## Anomaly Detection Heuristics

### 1. Impossible Travel Heuristic (`ImpossibleTravelDetector`)

The impossible travel heuristic inspects consecutive logins for the same account:

1. Derives approximate geographic coordinates for the current and previous client IPs via `GeoIpResolver`.
2. Calculates the great-circle Haversine distance ($d$) between both coordinates.
3. Calculates implied travel speed ($v = \frac{d}{\Delta t}$).
4. If $v$ exceeds the maximum plausible speed for commercial passenger aviation (default: 900 km/h) across significant distances ($> 50$ km), an `impossible_travel` `AnomalyFlag` is raised.

#### Why Heuristics Over ML?

- **Auditability & Explainability**: In regulated identity and compliance infrastructure, security teams must explain exactly why an event was flagged. A mathematical distance-over-time calculation is completely auditable and deterministic, unlike opaque statistical or deep learning models.
- **Zero Heavy Infrastructure Dependency**: Requires no vector databases, feature stores, or training pipelines; runs in-process with minimal memory footprint.
- **Advisory Posture**: The detector is advisory only. Geolocation data can occasionally shift due to VPN connections, mobile carrier roaming, or corporate proxy gateways. Flagging raises telemetry, triggers CAPTCHA/MFA prompts, or notifies security teams without causing false-positive account lockouts.

---

### 2. Volume Anomaly Detection (`VolumeAnomalyDetector`)

Fixed rate limits define absolute ceilings (e.g. 100 req/min). However, malicious scrapers or compromised accounts often operate at low volumes that fly under global ceilings.

`VolumeAnomalyDetector` addresses this by maintaining a rolling baseline per subject:

- Computes a Simple Moving Average (SMA) across configurable historical time windows (e.g. past 5 windows of 1 minute each).
- Flags a `volume_spike` `AnomalyFlag` if the current window volume exceeds the baseline by more than `thresholdMultiplier` (default: 3.0x).
- Enforces a minimum baseline floor (`minBaselineThreshold`) to eliminate cold-start false positives for low-traffic accounts.
- Distinguishes organic gradual growth (smooth baseline adjustments) from sudden automated bursts.
