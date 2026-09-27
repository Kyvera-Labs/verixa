# Multi-Factor Authentication (MFA) Architecture & Security Design

This document details Verixa's multi-factor authentication architecture, security invariants, threat model, and ceremony protocols.

---

## 1. Core Model & Method Decoupling

Verixa models second factors through an abstract aggregate family (`MfaMethod` in `packages/mfa/domain/entities/mfa-method.ts`) rather than discrete, uncoordinated tables. This ensures that the enforcement engine, step-up prompts, and session gates remain factor-agnostic: whether a challenge is satisfied via TOTP, WebAuthn/FIDO2, or backup recovery codes, the lifecycle rules (`pending`, `active`, `disabled`) remain uniform.

---

## 2. WebAuthn Registration Ceremony (`RegisterWebAuthnCredential`)

WebAuthn (FIDO2) provides hardware-backed, phishing-resistant credentials. Unlike shared secrets (such as passwords or TOTP seeds), the server **never** receives or stores a private key: the private key remains locked within the authenticator hardware (Secure Enclave, YubiKey, TPM), and only an asymmetric public key is registered with the Relying Party (RP).

### Registration Protocol Flow

```
User Agent (Browser)                  Verixa API                      Authenticator
         |                                |                                 |
         | --- 1. issueChallenge(userId) ->|                                |
         |                                | (generate 32-byte CSPRNG token) |
         | <- 2. { challenge, expiresAt } -|                                |
         |                                |                                 |
         | --- 3. navigator.credentials.create({ challenge, rp, user }) --->|
         |                                |                                 |
         |                                |    [Verify User Presence (UP)]  |
         |                                |    [Generate Keypair]           |
         |                                |    [Sign / Bind Origin & RP ID] |
         |                                |                                 |
         | <- 4. PublicKeyCredential ---------------------------------------|
         |    (clientDataJSON, attestationObject)                           |
         |                                |                                 |
         | --- 5. execute(registration) ->|                                 |
         |                                | 6. Verify Challenge & Consume   |
         |                                | 7. Verify ClientData Origin     |
         |                                | 8. Verify RP ID Hash & Flags    |
         |                                | 9. Extract Credential & PubKey  |
         |                                | 10. Persist active MfaMethod    |
         | <- 11. Ok({ mfaMethod, cred }) -|                                 |
```

### Phishing Resistance: Origin & RP-ID Protocol Binding

Origin and RP-ID binding is what makes WebAuthn phishing-resistant:

- A user tricked into navigating to a look-alike phishing domain (e.g. `https://verixa-login.phishing.example`) will have their browser populate `clientDataJSON.origin` with `https://verixa-login.phishing.example`.
- The browser queries the authenticator strictly for the origin shown in the browser address bar. The authenticator computes `rpIdHash = SHA256("verixa-login.phishing.example")`.
- When Verixa's `AttestationVerifier` verifies the attestation against the real RP ID (`verixa.example`) and real expected origin (`https://verixa.example`), the origin and RP ID hash checks mechanically fail.
- Unlike a TOTP code or SMS code—which a user can be deceived into relaying to an adversary—WebAuthn binding is enforced by client cryptographic hardware and browser security boundaries, rendering credential-forwarding attacks impossible.

### Single-Use and Time-Bounded Challenge Lifecycle

To protect against replay attacks and pre-computed registration responses:

1. **Single-Use Invariant:** Every challenge is stored in `WebAuthnChallengeRepository` and marked consumed immediately upon receipt in `RegisterWebAuthnCredential.execute()`. Any subsequent submission with the same challenge string is rejected with a validation error.
2. **Time-To-Live (TTL):** Challenges expire after 5 minutes (300,000 ms). Expired challenges are discarded, preventing stale challenges from lingering or being harvested.
3. **User Binding:** Challenges are strictly bound to the requesting `userId`. An attestation generated for User A cannot be redeemed by User B.

### Immediate Activation Invariant

In contrast to TOTP (which creates a `pending` method requiring an explicit `ConfirmTotpEnrollment` code verification step before activation), WebAuthn credentials are created directly as `active`.
_Design Decision & Alternatives Rejected:_

- **Rejected alternative (Two-step pending/activate ceremony for WebAuthn):** We rejected requiring an extra assertion step after registration. In TOTP, a user might scan a QR code incorrectly or fail to save the secret, so proof of code generation is required to prevent self-lockout. In WebAuthn, completing `navigator.credentials.create()` _is_ cryptographic proof of device possession, authenticator presence, and key generation. Adding a secondary confirmation step adds friction without increasing security.

### Storage: Public Key Only

`WebAuthnCredential` persists:

- `credentialId`: The unique identifier generated by the authenticator for key retrieval.
- `publicKey`: The public key bytes (COSE / base64url format).
- `signCounter`: The authenticator sign count (initialized at registration, used for clone detection in Issue 113).
- `transports`: Transport hints (`internal`, `usb`, `nfc`, `ble`, `hybrid`).
- `attestationType`: Attestation format (e.g. `none`, `packed`).

Even in the event of an arbitrary database compromise, no private key material exists on the server, eliminating offline credential cracking.

---

## 3. WebAuthn Authentication Ceremony (`VerifyWebAuthnAssertion`)

The authentication ceremony verifies that a user attempting to authenticate or step-up possesses the physical security key or platform passkey enrolled during registration.

### Authentication Protocol Flow

```
User Agent (Browser)                  Verixa API                      Authenticator
         |                                |                                 |
         | --- 1. issueChallenge(userId) ->|                                |
         |                                | (generate 32-byte CSPRNG token) |
         | <- 2. { challenge, expiresAt } -|                                |
         |                                |                                 |
         | --- 3. navigator.credentials.get({ challenge, rpId, allowCreds })>|
         |                                |                                 |
         |                                |    [Verify User Presence (UP)]  |
         |                                |    [Increment Signature Counter]|
         |                                |    [Sign AuthData || DataHash]  |
         |                                |                                 |
         | <- 4. PublicKeyCredential ---------------------------------------|
         |    (clientDataJSON, authenticatorData, signature)                |
         |                                |                                 |
         | --- 5. execute(assertion) ---->|                                 |
         |                                | 6. Verify Challenge & Consume   |
         |                                | 7. Verify ClientData Origin     |
         |                                | 8. Verify RP ID Hash & UP Flag  |
         |                                | 9. Verify Signature w/ PubKey   |
         |                                | 10. Check SignCounter (Clone)   |
         |                                | 11. Advance Counter & Touch TS  |
         | <- 12. Ok({ credential, mfa }) -|                                 |
```

### Signature Verification over `authenticatorData || clientDataHash`

The authenticator asserts possession by signing the concatenation of:

1. `authenticatorData` (containing RP ID hash, flags including User Presence `UP`, and the 32-bit big-endian signature counter).
2. `SHA-256(clientDataJSON)` (binding the challenge and origin).

`WebAuthnAssertionVerifier` loads the registered public key (COSE or PEM format) and cryptographically verifies the signature over this payload.

### Clone Detection via Signature Counter

FIDO2 authenticators maintain an internal monotonic counter (`signCount`) that increments with every assertion.

- **Legitimate usage:** Every assertion yields a `signCounter` strictly greater than the previously recorded counter (`newCounter > storedCounter`).
- **Clone detection:** If a physical authenticator's internal state or private key is cloned or copied to a second device, assertions from the cloned authenticator will produce counter values that collide with or lag behind the genuine authenticator (`newCounter <= storedCounter`).
- **Security Escalation:** When a non-increasing counter is observed (and counter tracking is active with `storedCounter > 0`), Verixa flags this as suspected credential duplication:
  1. Immediately emits a `WebAuthnCloneSuspected` domain event (`mfa.webauthn.clone_suspected`).
  2. Records an authentication failure attempt on the associated `MfaMethod` (triggering automatic lockout if repeated).
  3. Rejects the assertion ceremony with a validation error.
# Multi-Factor Authentication (MFA) Design

Verixa implements a flexible, policy-driven multi-factor authentication system. This document outlines the design decisions and security properties of the supported MFA methods.

## Time-Based One-Time Passwords (TOTP)

The TOTP implementation in Verixa strictly follows [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238).

### Algorithm and Parameters

We use the standard parameters supported by nearly all authenticator apps (Google Authenticator, Authy, Bitwarden, etc.):

- **Algorithm:** HMAC-SHA1
- **Time step (`period`):** 30 seconds
- **Code length (`digits`):** 6

While RFC 6238 supports SHA-256 and SHA-512, adoption among authenticator apps remains inconsistent. HMAC-SHA1 provides more than adequate security for TOTP, as the security bottleneck is the short, fast-expiring 6-digit code rather than the hash collision resistance.

### Secret Generation and Storage

The TOTP secret is a 20-byte value generated using a Cryptographically Secure Pseudorandom Number Generator (CSPRNG), yielding 160 bits of entropy. It is stored and communicated in Base32 encoding to remain compatible with standard `otpauth://` provisioning URIs and manual entry by users.

**Security invariants:**

- The secret is treated as highly sensitive. Like passwords, it is redacted across all serialization boundaries (`toJSON`, `toString`) to prevent accidental leaks in application logs.
- The secret is only displayed to the user once, during initial enrollment.

### Interoperability and Testing

Because TOTP's security relies on a shared secret and synchronized clocks, not algorithm secrecy, proving that the implementation exactly matches the RFC is critical.

The `TotpAlgorithm` domain service is explicitly tested against the standard test vectors provided in the RFC 6238 appendix. This guarantees that codes generated by standard authenticator apps will be correctly verified by our backend.

### Validation Time Window

Network latency, clock drift on the user's device, and the time it takes a user to type a code can cause a TOTP code to arrive just after its 30-second window expires.

To handle this gracefully, the verification algorithm accepts codes within a small sliding window (`Â±1` step, i.e., 30 seconds before or after the current server time). This provides a 90-second overall acceptance window, minimizing false rejections without significantly degrading security.
## TOTP Enrollment

When a user begins the TOTP enrollment process, we generate a CSPRNG base32 secret and an \otpauth://\ provisioning URI. 

**Why we persist a \pending\ method immediately:**
We persist the \MfaMethod\ immediately in a \pending\ state, rather than waiting for the first successful verification to persist anything.
*Alternative considered:* Hold the secret in a session or client-side, and only write to the database once confirmed (Issue 104).
*Reason rejected:* Storing the secret in a session requires distributed session state and complicates cross-device enrollment. Persisting as \pending\ is stateless for the API servers, avoids session bloat, and crucially ensures that we can strictly rate-limit confirmation attempts against a stable database record.

**Why the secret is returned exactly once:**
The enrollment use case returns the plaintext secret and provisioning URI exactly once to the caller.
*Alternative considered:* Store the secret in plaintext or allow re-retrieval.
*Reason rejected:* TOTP secrets cannot be one-way hashed because the server needs the plaintext to compute expected codes during login. However, storing them in plaintext is a severe risk in a database breach. We rely on symmetric encryption-at-rest at the storage layer (Issue 107). The plaintext is returned once to the caller solely to generate the QR code, minimizing its exposure. If a user fails to scan the QR code, they must generate a new pending method rather than retrieve the old secret.

### Confirming Enrollment

To transition a \pending\ method to \ctive\, the user must provide a valid 6-digit TOTP code generated by their device using the secret.

**Why we rate-limit enrollment confirmation:**
Even though the method is not yet gating a session, guessing attempts against the \pending\ method are rate-limited.
*Alternative considered:* Only rate-limit authentication challenges, since an unconfirmed secret doesn't gate access yet.
*Reason rejected:* A 6-digit code has only 1,000,000 possibilities. Unthrottled guessing within the 30-second window is computationally trivial for an attacker. If an attacker guesses the code for a pending method (e.g. they know the user is currently enrolling), they can activate it on behalf of the user, locking the user out or establishing a persistent backdoor. Rate-limiting the \pending\ state is as important as the \ctive\ state.

## TOTP Verification & Replay Protection

During login or step-up authentication, the server verifies a submitted TOTP code against an \ctive\ method, allowing a minor configurable clock drift (e.g., ±1 time step).

**Why we track the \lastUsedStep\:**
Clock-drift tolerance is a usability necessity (phones and servers rarely agree to the second), but each extra step widens the window in which a single 6-digit code is valid.
*Alternative considered:* Accept any code that mathematically validates within the current or adjacent time step without persistent state.
*Reason rejected:* Accepting a code unconditionally enables immediate replay attacks within the 30-90 second validity window. If a user enters their code on a compromised network or phishing proxy, the attacker could reuse the same code milliseconds later. By persisting the \lastUsedStep\ on the \MfaMethod\ and strictly rejecting any authentication attempt that maps to a step less than or equal to it, we completely neutralize replay attacks within the drift window.
# MFA Design & Security Properties

## Backup Codes

Backup codes provide a critical recovery path for users who lose access to their primary second factors (like a TOTP device or passkey). 

### Storage Strategy: Hashed, Never Encrypted

Unlike TOTP secrets—which must be symmetrically encrypted at rest because the server requires the plaintext to compute the expected HMAC during login—backup codes are **hashed** using a slow key derivation function (Argon2), identical to the strategy we use for passwords in Issue 061.

**Why?**
Backup codes are effectively low-entropy, system-generated passwords. They are used exactly once and presented in plaintext by the user. 
If we encrypted them at rest (like TOTP secrets), an attacker with database read access and the application's encryption key could decrypt the backup codes and bypass MFA on any account. By hashing them instead, we ensure that even a full compromise of the database and the environment variables (including the encryption key) does not reveal the backup codes. The server only needs to verify the hash when a user submits a code, meaning it never needs to recover the plaintext.

### Single-Use Enforcement

Each backup code is single-use. Once a code is successfully verified, its corresponding hash must be immediately removed from the database to prevent replay attacks. Because they are hashed, removing a single code's hash does not compromise the security of the remaining unused codes in the set.

### Regeneration and Atomic Invalidation

When a user requests a new set of backup codes, the new set completely replaces any previously issued codes for that account. This is implemented via an atomic invalidation-and-reissue in the GenerateBackupCodes use case: any existing MfaMethod of type ackup_codes is deleted before the new one is persisted.

**Why?**
We deliberately rejected the alternative of "appending" new codes to an ever-growing pool of valid backup codes. While an additive pool might seem more forgiving if a user finds an old printout, it is insecure: it means a compromised set of codes remains permanently valid unless explicitly revoked by the user, and an attacker who gains temporary access could generate a second set for themselves without alerting the user by breaking the first set. Full-set replacement guarantees that the user always has exactly one authoritative, finite set of codes at any time, and that generating a new set acts as an implicit revocation of any previously compromised or lost sets.
