# ADR-0003: External audit-log anchoring via Stellar

## Status

Accepted — the anchoring mechanism is implemented and tested against the
live Stellar testnet in `packages/stellar-anchor` (`@verixa/stellar-anchor`).
See `docs/guides/stellar-anchoring.md`.

What exists: the `HashAnchor` port, the `StellarHashAnchor` adapter
(`MEMO_HASH` commitment plus Horizon-based verification), an
`InMemoryHashAnchor` fake that doubles as the anchoring-disabled option, a
shared behavioral contract both implementations pass, and a CLI for
anchoring and independently verifying a hash.

What does not exist yet: the consumer. `packages/audit` arrives in Phase 10,
so nothing currently produces a hash chain to anchor. The scheduled job that
periodically anchors a chain tip, and the extension of `VerifyAuditChain`
(Issue 191) to check anchors, land with that phase — tracked as Issue 190A.

Built ahead of its consumer deliberately: the mechanism is independently
useful and independently verifiable, and proving the Stellar mechanics work
against a real ledger is worth doing before an audit subsystem depends on
them.

## Context

Issue 190 gives Verixa's audit log tamper evidence via per-organization
hash chaining: each event's hash commits to the previous event's hash, so
altering any past record breaks every hash after it. This is real
protection, but it has one structural limit — it only proves tampering
_within the database Verixa itself controls_. An attacker (or a
compromised/malicious operator) with sufficient database access can, in
principle, rewrite an entire chain from some point forward and produce a
new chain that is internally consistent. Hash chaining alone can't
distinguish "the real history" from "a fabricated but self-consistent
alternate history," because both live in the same trust boundary.

The standard fix for this class of problem is **external anchoring**:
periodically publish a commitment to the chain's current state somewhere
outside the system's own control, so a tampered rewrite would also have to
match a record nobody who tampered with the database could have altered.
This is a well-established pattern (certificate transparency logs, RFC
3161 trusted timestamping, and — closer to this specific mechanism —
anchoring a Merkle/hash-chain root to a public blockchain).

A public ledger is a reasonable anchoring target because it's
append-only, globally witnessed, and cheap to write a small commitment to.
Stellar specifically fits well on the mechanics: sub-5-second transaction
finality, negligible fees, and a `MEMO_HASH` memo field that is exactly 32
bytes — precisely the size of a SHA-256 digest, so the chain-tip hash fits
without truncation or encoding tricks. No smart-contract layer or token
economics are required, since the only thing being used is "an append-only
public ledger that will timestamp a hash for a fraction of a cent."

## Decision

Add an `AuditAnchorPort` to `packages/audit/application/ports/`:

```ts
interface AuditAnchorPort {
  anchor(hash: string): Promise<AnchorReceipt>;
  // AnchorReceipt: { anchorId: string; anchoredAt: Date; anchorRef: string }
  // anchorRef is anchor-implementation-specific (a Stellar tx hash, here)
}
```

`StellarAuditAnchor` (`packages/audit/infrastructure/anchoring/`) implements
it: periodically (a configurable interval, not per-event — anchoring every
single event would be wasteful and unnecessary given the hash chain already
covers per-event integrity) submits the current chain-tip hash as a Stellar
transaction memo, and records the resulting transaction hash against the
anchored range of events.

This is a **port**, following the same pattern as every repository in this
codebase (see `docs/guides/domain-modeling.md`): the audit domain and
application layers depend only on `AuditAnchorPort`, never on
Stellar-specific types. A deployment that doesn't want a Stellar dependency
can run with anchoring disabled, or (future work, not this ADR) implement
the port against a different anchor. Stellar is the first, motivating
adapter, not a hard requirement baked into the domain.

Verification (`VerifyAuditChain`, Issue 191) extends to optionally confirm
a given chain range's hash matches what's recorded on-chain at its
`anchorRef` — independently checkable by anyone with the Stellar
transaction hash, without needing any access to or trust in Verixa's own
database.

## Consequences

- **Genuine, load-bearing use of Stellar**, not a bolted-on integration:
  it fills a real gap hash chaining alone leaves open, using a mechanism
  (public, append-only, cheaply-writable ledger) Stellar is well-suited
  for on the merits.
- **Optional, not load-bearing for Verixa's core function.** Verixa's
  auth/identity/authorization functionality has zero dependency on this —
  anchoring only strengthens the audit-log integrity guarantee for
  deployments that enable it. A deployment with no interest in Stellar
  loses nothing by leaving it off.
- **New operational dependency when enabled**: a funded Stellar account to
  submit anchoring transactions from, and a key-management story for it —
  scoped in detail when Issue 190A is actually implemented, not here.
- **Anchoring interval is a real tradeoff**: too frequent wastes fees for
  negligible added integrity (the hash chain already covers per-event
  tampering); too infrequent widens the window an attacker could rewrite
  history undetected by external anchoring specifically (the hash chain
  itself is unaffected either way). Default interval to be set based on
  real usage once implemented.

## Alternatives Considered

- **No external anchoring, hash chaining only** — rejected as the sole
  mechanism for exactly the reason in Context: it can't distinguish real
  history from a fully-rewritten-but-consistent fake, given sufficient
  database access.
- **A centralized trusted-timestamping service (RFC 3161 TSA)** —
  rejected as the primary choice: reintroduces a trusted third party,
  which is precisely what a public ledger avoids. Could still be added
  later as a second, independent `AuditAnchorPort` implementation if
  redundant anchoring is ever wanted — the port design doesn't preclude it.
- **Bitcoin (via OP_RETURN)** — technically viable for the same purpose,
  but slower finality (~10+ minutes vs. Stellar's ~5 seconds) and
  materially higher, more volatile fees make it a worse fit for frequent
  small commitments.
- **Anchor every single audit event individually** — rejected: the hash
  chain already makes every event's integrity depend on the one before it,
  so anchoring the current chain tip at an interval anchors every event up
  to that point transitively. Anchoring per-event would multiply
  transaction cost for no added guarantee.
