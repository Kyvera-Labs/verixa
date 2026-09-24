# Token Design & JWT Access Tokens

This document covers the design decisions and implementation of access tokens in Verixa, focusing on JWT-based (stateless-verifiable) short-lived tokens paired with refresh tokens for session management.

## Executive Summary

- **Access tokens** are short-lived JWTs (typically 15 minutes) signed with RS256 (asymmetric). They carry enough claims to be verified without a database lookup.
- **Refresh tokens** are long-lived, opaque, and revocable. They live in the database and are never embedded in a JWT.
- This split allows fast, stateless verification of access tokens while maintaining the ability to revoke sessions and detect token theft.

---

## Why JWT?

JWTs solve the central challenge of scalable session management: **How do you verify a user's identity on every request without hitting the database on every request?**

### The Problem

In a monolithic application, a session store (often Redis or an in-memory map) holds all active sessions. On each request, the server looks up the session and returns a "yes, valid" or "no, invalid" decision. This is simple but doesn't scale across multiple servers:

- If Server A issues a session and Server B receives a request with that token, Server B must query a shared store to verify it. That store becomes a bottleneck.
- If the shared store goes down, all servers stop authenticating requests.

### The JWT Solution

A JWT encodes the claims (user ID, issued-at time, expiration) directly into the token. The token is digitally signed so it cannot be forged or tampered with. Any server holding the public signing key can verify the token immediately, without a database lookup:

```
Request with token → Verify signature → Extract claims → Grant access (if not expired)
```

This is **stateless verification**. It scales to thousands of servers without a shared session store.

### The Cost: No Immediate Revocation

Once a JWT is issued and valid, a service verifying it has no way to know if the user later logged out or their session was revoked. The token will be accepted until it expires.

This is solved (in Phase 05) with a short TTL (typically 15 minutes) plus a deny-list (Issue 088): on logout or session revocation, the session ID is added to a short-lived Redis deny-list. Verifiers check the deny-list alongside signature verification. If the session ID is listed, the token is rejected despite being valid.

This hybrid approach (stateless verification + short-lived deny-list) gives us both scalability and immediate revocation.

---

## Access Token Claim Set

An access token carries the following claims:

### Standard JWT Claims

- **`iat` (issued at):** Unix timestamp when the token was signed. Used to detect clock skew.
- **`exp` (expiration):** Unix timestamp when the token expires. Verifiers reject tokens where `exp` is in the past.

### Custom Claims

- **`sub` (subject):** The user ID. Used by the service to know who is making the request.
- **`sid` (session ID):** The session this token belongs to. Allows revoking all tokens from a session without waiting for expiration.
- **`orgId` (organization ID):** The tenant/organization. Used for multi-tenancy: a service can scope queries or make quick authorization checks without decoding the full token.
- **`kid` (key ID):** Identifies which signing key was used. Enables zero-downtime key rotation (Issue 085): if a new key pair is created, the old public key is kept for verification of tokens issued moments before rotation. Verifiers use `kid` to look up the correct public key.

### Why These Claims?

- **Minimal:** We deliberately don't include roles, permissions, or other fine-grained authorization data in the token. Reasons:
  - Tokens must be short-lived because they carry stale data. If permissions changed 10 minutes after issuance, the token would still grant the old permissions until it expires.
  - Fine-grained authorization is deferred to a policy engine (Phase 08) that fetches fresh data from the database.
  - Keeping the token small reduces overhead (smaller JWT = smaller HTTP headers).
- **Enough to route and revoke:** The claims are sufficient to route a request to the right service and determine if the session was revoked.

Example decoded token:

```json
{
  "sub": "user-123",
  "sid": "session-456",
  "orgId": "org-789",
  "iat": 1705334400,
  "exp": 1705335300,
  "kid": "2024-01-15-v1",
  "alg": "RS256",
  "typ": "JWT"
}
```

---

## Signing Algorithm: RS256 (RSA-SHA256)

Verixa uses RS256 (RSA asymmetric signing) rather than HS256 (HMAC symmetric).

### Why RS256?

| Aspect | RS256 (Asymmetric) | HS256 (Symmetric) |
|--------|-------------------|-------------------|
| **Key sharing** | Public key is public; private key is held only by the issuer | Secret key must be shared with every verifier |
| **Verifier distribution** | Scale from one issuer to hundreds of verifiers | Verifiers must be trusted with the signing secret |
| **Key compromise** | If a verifier's public key is leaked, tokens can still be verified but not forged | If any verifier's copy of the secret is leaked, an attacker can forge tokens |
| **Key rotation** | Easy: retire old public key, issue new one, keep both for a grace period | Harder: must rotate secret across all verifiers in lockstep |
| **JWKS endpoints** | Natural fit (publish public keys at a well-known endpoint) | Not a good fit (you don't publish signing secrets) |

For Verixa, RS256 aligns with the architecture: a single auth service signs tokens, while multiple API services and gateways verify them independently. HS256 would require sharing the signing key with every service, multiplying the attack surface.

### Implementation

Access tokens are signed and verified using the `jose` library with RS256:

- **Signing:** The private key (PKCS#8 PEM format) is held in a secure config store. The `JwtTokenSigner` service loads it once and caches the imported key to avoid repeated PEM parsing.
- **Verification:** Services hold the public key (SPKI PEM format). They verify the signature and extract claims without any database lookup.
- **Key format:** PEM-encoded RSA keys. Keys are imported once per signer/verifier instance and cached for performance.

---

## Token Lifetime & Expiry

Access tokens are **short-lived**: typically 15 minutes. This is a security/UX tradeoff:

### Why Short?

1. **Limits damage if stolen:** If an attacker intercepts an access token, they have a narrow window (15 minutes) to use it before it expires.
2. **Limits staleness:** If a user's permissions change (they're removed from a group, their account is locked), the old token is rejected after 15 minutes at most.
3. **Enables cheap revocation:** A deny-list only needs to hold entries for 15 minutes. Redis memory usage is bounded.

### Why Not Longer?

- Longer tokens increase the window an attacker has to use a stolen token.
- Permissions changes take longer to take effect, which is a security concern for emergency lockdowns.
- Deny-lists become larger and more expensive to maintain.

### Why Not Shorter?

- Shorter tokens require more frequent refreshes, increasing load on the auth service.
- More frequent refreshes increase attack surface (more opportunities to steal a refresh token).
- Users get logged out unexpectedly if they leave their browser for too long without activity.

**15 minutes is a standard choice in the OAuth 2.0 and OpenID Connect communities.** Verixa makes it configurable so operators can adjust based on their security posture and load.

---

## Refresh Tokens

Refresh tokens are **long-lived** (typically 7 days), **opaque** (not JWTs), and **revocable** (stored in the database as a hashed value).

### Why Separate Refresh Tokens?

If access tokens were long-lived (like 7 days), a stolen token would grant an attacker a week of access. Refresh tokens solve this:

1. On each login, the server issues an access token (15 minutes) and a refresh token (7 days).
2. When the access token expires, the client exchanges the refresh token for a new access token (and a new refresh token, via rotation; Issue 089).
3. If an access token is stolen, the attacker can use it for 15 minutes. If a refresh token is stolen, the attacker must exchange it for an access token, which is detectable and can trigger theft detection (Issue 090).

### Why Opaque?

Refresh tokens are opaque (high-entropy random strings) rather than JWTs because:

1. **Revocability:** A refresh token's usefulness ends the moment it's used (rotate-on-use). The token doesn't carry an expiration; revocation is immediate.
2. **Security:** An opaque token that is hashed before storage is much safer than a JWT. A leaked database dump won't yield usable tokens (the attacker would need to reverse the hash).
3. **Simplicity:** No need to parse and verify claims; just check the hash.

---

## Key Rotation (Issue 085)

Verixa supports zero-downtime key rotation for signing keys.

### The Problem

When a signing key needs to be rotated (e.g., suspected compromise, annual rotation), the old key must be retired and a new one put in place. But tokens issued moments before rotation are still valid and carry the old key ID (`kid`). If the old key is deleted immediately, verification of those tokens fails.

### The Solution

1. Create a new RSA key pair and assign it a new `kid` (e.g., "2024-02-15-v2").
2. Both keys are kept in the system: the new one is used for signing new tokens, the old one is kept for verifying existing tokens.
3. Tokens issued with the old key carry `kid: "2024-01-15-v1"`. Verifiers look up that key ID and use the corresponding public key to verify.
4. After all tokens issued with the old key have expired (typically 15 minutes for access tokens), the old key can be deleted.

### Implementation

The `SigningKeyProvider` (Issue 085) maintains a map of active keys keyed by `kid`. The current signing key is used by `TokenSigner.sign()`. Verification uses the key ID in the token header to look up the corresponding public key.

---

## Threat Model: Session & Token Flows

### Token Theft

**Threat:** An attacker intercepts an access token (e.g., via network sniffing, XSS) and uses it to impersonate the user.

**Mitigations:**
- Access tokens are short-lived (15 minutes). An attacker's window to use a stolen token is bounded.
- Tokens are transmitted over HTTPS to prevent network interception.
- A deny-list (Issue 088) allows immediate revocation if compromise is suspected.

### Refresh Token Theft

**Threat:** An attacker intercepts a refresh token and uses it to obtain a new access token.

**Mitigations:**
- Refresh tokens are high-entropy and hashed before storage. A leaked database dump won't yield usable tokens.
- Refresh tokens are rotate-on-use: each use invalidates the old token and issues a new one. An attacker can use a stolen refresh token once, at most twice (if they retry a in-flight request before the server processes the first one).
- Reuse detection (Issue 090) triggers theft detection: if a refresh token that has already been rotated is presented again, the entire token family and session are revoked, and a security event is emitted.

### Token Fixation

**Threat:** An attacker tricks a user into authenticating with a token the attacker chose (or predicted).

**Mitigations:**
- Tokens are issued by the auth service only, not accepted from clients. A client cannot present a "pre-chosen" token for authentication.
- Session IDs are unpredictable (random UUIDs), so an attacker cannot predict a token the auth service would issue.

### Revocation Bypass

**Threat:** A user logs out, but their old token continues to work because the server never checked revocation.

**Mitigations:**
- On logout, the session is revoked in the database and added to the deny-list (Issue 088).
- Verifiers check the deny-list after verifying the signature. A revoked session ID in the deny-list causes verification to fail despite the token being otherwise valid.
- The deny-list has the same TTL as access tokens (15 minutes), ensuring coverage without unbounded memory growth.

### Unauthorized Authorization Escalation

**Threat:** An attacker modifies an access token to grant themselves elevated permissions.

**Mitigations:**
- Access tokens are digitally signed. Modifying any field invalidates the signature.
- An unsigned or differently-signed token is rejected by verifiers.
- Permissions are not embedded in the token (by design). Fine-grained authorization is determined by querying the database or a policy engine, not from stale token claims.

---

## Implementation: `JwtTokenSigner` (Issue 084)

### API

```typescript
interface TokenSigner {
  sign(params: IssueAccessTokenParams): Promise<SignedAccessToken>;
  verify(token: string): Promise<AccessTokenClaims>;
}
```

### Signing

```typescript
const signer = new JwtTokenSigner(privateKeyPem, publicKeyPem, keyId);
const result = await signer.sign({
  userId: "user-123",
  sessionId: "session-456",
  organizationId: "org-789",
  expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
});
// result.token is a JWT string
// result.claims are the decoded claims (for convenience)
```

### Verification

```typescript
const claims = await signer.verify(token);
// claims is an AccessTokenClaims object
// If verification fails (invalid signature, expired, malformed), an error is thrown
```

### Error Handling

Verification can throw:

- `InvalidSignatureError`: The signature is invalid (forged or tampered).
- `ExpiredTokenError`: The token's `exp` claim is in the past.
- `MalformedTokenError`: The token is structurally invalid (missing claims, invalid JSON, etc.).

---

## Contract Testing

The `TokenSigner` port is tested via contract tests (Issue 097):

1. A reference implementation (the `jose`-based `JwtTokenSigner`) is tested.
2. Any future implementation (e.g., a different crypto library) must pass the same contract tests.
3. Contracts verify: sign/verify round-trip, signature rejection on tampering, expiry checks, missing-claim rejection.

---

## Security Checklist

- [ ] All access tokens are transmitted over HTTPS.
- [ ] Private signing keys are stored in a secure config store (e.g., environment variables, HSM).
- [ ] Public verification keys are available to all services that need to verify tokens.
- [ ] Key rotation procedure is tested and documented.
- [ ] Revocation (via deny-list) is implemented and tested.
- [ ] Token reuse detection (Issue 090) is enabled for refresh tokens.
- [ ] Tokens are never logged or stored in audit logs in unredacted form.
- [ ] Token lifetime (TTL) is set to a value appropriate for your security posture (default 15 minutes for access tokens).

---

## References

- **Phase 05:** Sessions & Tokens (Issues 081–100)
- **Issue 084:** JWT access token design & signing service (this issue)
- **Issue 085:** Signing key management & rotation
- **Issue 088:** Redis-backed revocation / deny-list adapter
- **Issue 089:** Refresh token rotation
- **Issue 090:** Refresh-token reuse detection (theft detection)
- **OAuth 2.0 RFC 6749:** https://tools.ietf.org/html/rfc6749
- **OpenID Connect Core:** https://openid.net/specs/openid-connect-core-1_0.html
- **JWT RFC 7519:** https://tools.ietf.org/html/rfc7519
- **OWASP: Token Storage:** https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html

---

## Next Steps

1. **Issue 085:** Implement `SigningKeyProvider` for key rotation support.
2. **Issue 086:** Define `RefreshToken` entity (opaque, hashed).
3. **Issue 087:** Implement `IssueSession` use case to tie tokens and sessions together.
4. **Issue 088:** Implement Redis-backed deny-list for revocation.
5. **Issue 089:** Implement `RefreshAccessToken` use case (rotation).
6. **Issue 090:** Implement reuse detection for stolen refresh tokens.
