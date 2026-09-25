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
