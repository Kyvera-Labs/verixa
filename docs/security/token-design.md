# Access Token Design & JWT Implementation

**Issue:** #24 (Roadmap 084) — JWT access token design & signing service  
**Phase:** Phase 05 — Sessions & Tokens

This document covers the design and implementation of short-lived, stateless-verifiable access tokens in Verixa.

## Overview

Access tokens prove a user's identity and session validity to downstream services without requiring a database round trip. Verixa uses short-lived JWTs (15 minutes) signed with RS256 (asymmetric), paired with long-lived, revocable refresh tokens.

The split accomplishes two goals:

1. **Stateless verification:** Any service with the public key can verify an access token without contacting the auth service or a database.
2. **Immediate revocation:** A session revocation is recorded immediately; downstream verifiers check a revocation list (Issue 088) after signature verification succeeds.

## The Claim Set: sub, sid, orgId, iat, exp, kid

```json
{
  "sub": "user-123",
  "sid": "session-456",
  "orgId": "org-789",
  "iat": 1705334400,
  "exp": 1705335300,
  "kid": "2024-01-15-v1"
}
```

| Claim | Type | Purpose | Why It's Here |
|-------|------|---------|--------------|
| **sub** (subject) | UserId | The user making the request | Every request is from someone; services need to know who |
| **sid** (session ID) | SessionId | Links the token to its session | Enables session-level revocation without token expiry wait |
| **orgId** (organization) | string | The tenant/organization | Multi-tenancy: scope queries without a user lookup |
| **iat** (issued at) | Unix timestamp | When the token was signed | Detect clock skew; validate freshness |
| **exp** (expiration) | Unix timestamp | When the token expires | Verifiers reject tokens where `exp ≤ now` |
| **kid** (key ID) | string | Which signing key was used | Enable zero-downtime key rotation (Issue 085) |

## Why This Claim Set Is Minimal

The key insight: **access tokens are short-lived and stale.** If we embedded roles, permissions, or other fine-grained authorization data, that data would become stale the moment a permission changed. The user's token would still grant the old permission until it expired or was explicitly refreshed.

Instead, Verixa defers fine-grained authorization to a **policy engine** (Phase 08) that queries fresh data from the database on each request. The token carries only enough to:

1. **Route the request:** Know which user and organization the request is for.
2. **Check revocation:** Know which session the token belongs to, so a revoked session can be checked.

This separation keeps tokens small (smaller HTTP headers, faster serialization), and keeps authorization current (permissions changes take effect immediately at the policy engine, not waiting for token refresh).

### Alternatives Rejected

- **Full permission list in the token:** Stale, breaks on permission changes, and grows with user responsibility. Rejected.
- **Role name only (e.g., `role: "admin"`):** Still stale, still requires a role-to-permission mapping lookup, no real savings. Rejected.
- **No orgId:** Worse UX for multitenant systems (every service does a user lookup to know which org the user belongs to). Rejected.

## RS256 vs. HS256: Asymmetric vs. Symmetric Signing

Verixa uses **RS256 (RSA asymmetric signing)**, not HS256 (HMAC symmetric). This choice has profound architectural consequences.

### Symmetric (HS256)

- **One secret:** Both sign and verify use the same HMAC secret.
- **Distribution:** The secret must be shared with every service that verifies tokens.
- **Compromise:** If any verifier's copy is compromised, an attacker can forge tokens.
- **Key rotation:** Requires all verifiers to be updated in lockstep, or verification breaks. Operationally expensive.
- **JWKS endpoints:** Impossible (you don't publish signing secrets).

### Asymmetric (RS256)

- **Two keys:** A private key signs, a public key verifies.
- **Distribution:** Only the auth service needs the private key. Any other service just needs the public key (which can be published freely at a JWKS endpoint).
- **Compromise:** If a verifier's copy of the public key is compromised, tokens can still be verified but not forged. The attacker can't create new tokens.
- **Key rotation:** Create a new key pair; publish both old and new public keys for a grace period. Tokens issued with the old key are still verified until they expire.
- **JWKS endpoints:** Natural fit. Standard practice in OAuth 2.0 and OpenID Connect.

### Decision Rationale

For a single-service monolith, the difference is moot: HS256 is simpler. But Verixa is designed for growth:

- An API gateway might need to verify tokens before routing.
- Microservices might verify tokens independently.
- Webhooks or third-party integrations might need to verify tokens.
- Desktop or mobile clients might verify tokens locally (for offline UX).

In all these cases, RS256 is the natural choice: the public key is public, so anyone can verify, and the private key stays in the auth service. HS256 would require sharing the secret with every verifier, multiplying the surface area for compromise.

**Decision:** Start with RS256 now (it's what you'd eventually migrate to anyway), avoid a breaking change later.

## Token Lifetime: 15 Minutes for Access, 7 Days for Refresh

### Access Token: 15 Minutes (Stateless, Short-Lived)

- **Why short?** Limits the window an attacker has to use a stolen token. Limits stale authorization data (permissions changes take effect in 15 minutes max).
- **Why not shorter?** More frequent refreshes increase load and attack surface.
- **Why not longer?** Defeats the purpose; might as well use refresh tokens as access tokens.

The 15-minute TTL is a standard in OAuth 2.0 and OpenID Connect. Verixa makes it configurable so deployments can adjust based on their risk profile and load.

### Refresh Token: 7 Days (Stateful, Revocable)

- **Why long?** Avoids frequent re-authentication. Users don't want to log in every 15 minutes.
- **Why stateful?** Can be revoked immediately (logged-out user gets a new token, old one rejected, all on the same day).
- **Why hashed in database?** A stolen database dump doesn't yield usable refresh tokens (only their hashes).

See the sections below for refresh token details (Issue 086) and theft detection (Issue 090).

## The Architecture: Hybrid Stateless + Deny-List

Access tokens are **stateless JWTs**: verification requires only the public key, no database lookup. But "stateless" doesn't mean "unrevocable" — it means the verification step doesn't require state.

### On Logout or Revocation

1. The session is revoked in the database (status = "revoked").
2. The session ID is added to a **deny-list** (Redis, Issue 088) with a TTL equal to the access token lifetime (15 minutes).
3. Downstream services verify the token signature (fast, no DB), then check the deny-list (also fast, local cache or Redis).

If the session is in the deny-list, the token is rejected despite being otherwise valid.

### Why a Deny-List, Not a Full Session Store?

A deny-list bounds memory usage by token TTL (entries expire after 15 minutes). A full session store grows without bound. For a deployment with millions of users, the difference is massive.

### Revocation Latency

Revoking a session is "immediate" in the sense that it's written to the database right away. But verifiers don't instantly see the revocation if they're using a cached copy of the deny-list. This is an accepted tradeoff: a brief window (seconds) where a revoked token might still work, in exchange for avoiding a synchronous write to every verifier across a cluster.

This is standard practice in OAuth 2.0 systems and similar to how browser certificate revocation works (CRLs and OCSP, neither of which guarantee instant knowledge of revocation).

## Key Rotation: Zero-Downtime with kid

Signing keys must eventually be rotated:

1. **Security:** Periodic rotation bounds the damage of key compromise.
2. **Compliance:** Some standards require rotation on a schedule (e.g., annual).
3. **Predictability:** Scheduled rotation is better than emergency rotation after compromise.

### The Problem

When a new key pair is created, tokens issued moments before the rotation are still valid (they have the old key ID in their `kid` header). If the old key is deleted immediately, verification of those tokens fails.

### The Solution (Issue 085)

1. Both the old and new public keys are published simultaneously.
2. Verifiers use the token's `kid` header to look up which key to use.
3. After all tokens issued with the old key have expired (15 minutes for access tokens), the old key is deleted.

This is standard practice (RFC 7517, JWKS) and enables zero-downtime rotation.

## Refresh Tokens: Stateful, Revocable, Opaque (Issue 086)

Refresh tokens are **not JWTs**. They're high-entropy opaque strings, hashed before storage, and revocable.

| Property | Access Token | Refresh Token |
|----------|--------------|---------------|
| Format | JWT | Opaque string |
| TTL | 15 minutes | 7 days |
| Verification | Stateless (public key only) | Stateful (database lookup) |
| Revocation | Deny-list | Database status |
| Compromise window | 15 minutes | Until refresh (rotating) |

Refresh tokens live in the database so they can be revoked immediately. Their values are hashed (like passwords) so a stolen database dump doesn't yield usable tokens.

## Refresh Token Rotation (Issue 089)

Every time a refresh token is used, a new one is issued and the old one is immediately invalidated. This limits the usefulness of a stolen refresh token to a single request.

## Theft Detection: Reuse Detection (Issue 090)

If a refresh token that has already been rotated (superseded) is presented again, it's evidence of theft:

1. The entire token family (all tokens descended from the stolen one) is revoked.
2. The session is revoked.
3. A security event is emitted.

This turns token rotation from a hygiene measure (limits exposure window) into an **active theft detection mechanism** (notifies the user and operator).

## Threat Model

### Threat: Access Token Theft

**Attack:** Attacker intercepts an access token (network sniffing, XSS, compromised device).

**Mitigation:**
- Token is short-lived (15 minutes). Attacker's window is bounded.
- HTTPS prevents network interception.
- Revocation list allows immediate session revocation if compromise is suspected.

### Threat: Refresh Token Theft

**Attack:** Attacker intercepts a refresh token.

**Mitigation:**
- Refresh token is opaque and hashed. A stolen database dump doesn't yield usable tokens.
- Token is revoked on first use (rotate-on-use). Attacker can use it at most once.
- Reuse detection triggers theft detection. Presenting a rotated token revokes the entire family and session, and emits a security event.

### Threat: Token Forgery

**Attack:** Attacker forges a token (crafts a JWT, signs it with their own key).

**Mitigation:**
- Tokens are signed with RS256. Forging requires the private key (which only the auth service has).
- Verifiers check the signature before accepting any claims. A forged token is rejected immediately.

### Threat: Tampered Token

**Attack:** Attacker modifies an existing token (changes claims, e.g., `sub` to impersonate another user).

**Mitigation:**
- Any modification invalidates the signature.
- Verifiers reject tokens with invalid signatures. Tampering is detected immediately.

### Threat: Revocation Bypass

**Attack:** A user logs out, but their old token continues to work.

**Mitigation:**
- On logout, the session is revoked and added to the deny-list.
- Verifiers check the deny-list. Revoked sessions are rejected despite valid tokens.

### Threat: Token Fixation

**Attack:** Attacker tricks a user into authenticating with a token the attacker chose.

**Mitigation:**
- Tokens are issued by the auth service only, not accepted from clients.
- Session IDs are unpredictable (random UUIDs). An attacker cannot predict a token the auth service would issue.

## Implementation: JwtTokenSigner

The `JwtTokenSigner` class (infrastructure/jwt-token-signer.ts) implements the `TokenSigner` port using Node's native crypto module (via the `jose` library).

### API

```typescript
const signer = new JwtTokenSigner(privateKeyPem, publicKeyPem, keyId);

// Sign: returns Result<SignedAccessToken, SigningError>
const signResult = await signer.sign({
  userId,
  sessionId,
  organizationId,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});

// Verify: throws InvalidSignatureError, ExpiredTokenError, or MalformedTokenError
const claims = await signer.verify(token);
```

### Key Caching

RSA key import (parsing PEM) is expensive. The signer caches both keys after the first import, so subsequent calls reuse them. This is safe: crypto key objects are immutable.

### Thread Safety

The signer is stateless and thread-safe. Multiple concurrent `sign()` and `verify()` calls do not interfere with each other.

## Testing

The test suite covers:

1. **Sign/verify round-trip:** Tokens sign and verify correctly.
2. **Tamper detection:** Modifying the payload or signature causes verification to fail.
3. **Expiry:** Expired tokens are rejected.
4. **Malformed tokens:** Missing claims or invalid structure is caught.
5. **Key caching:** Keys are cached and reused across calls.
6. **Concurrent operations:** Multiple simultaneous sign/verify calls work correctly.
7. **Error types:** Each failure mode throws the expected error type.

All tests are unit tests (no database, no external services) and fail without the implementation (no tautological assertions like "expect(tokenSigner).toBeDefined()").

## Security Checklist

- [ ] All access tokens are transmitted over HTTPS only.
- [ ] Private signing keys are stored in a secure config store (environment variables, HSM, etc.).
- [ ] Public verification keys are available to all services that need to verify tokens.
- [ ] Key rotation procedure is tested (new keys can coexist with old for a grace period).
- [ ] Revocation via deny-list (Issue 088) is implemented.
- [ ] Token reuse detection (Issue 090) is implemented.
- [ ] Tokens are never logged or stored unredacted in audit logs.
- [ ] Access token TTL is appropriate for the deployment's risk profile (15 minutes is a recommendation, not a requirement).

## References

- **RFC 7519:** JWT specification. https://tools.ietf.org/html/rfc7519
- **RFC 7517:** JSON Web Key. https://tools.ietf.org/html/rfc7517
- **OAuth 2.0 RFC 6749:** Authorization Framework. https://tools.ietf.org/html/rfc6749
- **OpenID Connect Core:** https://openid.net/specs/openid-connect-core-1_0.html
- **OWASP Token Security:** https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html

## Next Steps

- **Issue 085:** Implement `SigningKeyProvider` for multi-key support and rotation.
- **Issue 086:** Define `RefreshToken` entity (opaque, hashed).
- **Issue 087:** Implement `IssueSession` use case (creates a Session + issues token pair).
- **Issue 088:** Implement Redis-backed deny-list for revocation.
- **Issue 089:** Implement `RefreshAccessToken` use case (token rotation).
- **Issue 090:** Implement reuse detection for stolen refresh tokens.
