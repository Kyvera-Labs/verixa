# Stellar Anchoring

`@verixa/stellar-anchor` commits a hash to the Stellar ledger and lets
anyone verify that commitment afterwards. It exists to close a specific gap
in audit-log integrity — see
[`docs/adr/0003-stellar-audit-anchoring.md`](../adr/0003-stellar-audit-anchoring.md)
for the decision and the alternatives that were rejected.

## The problem it solves

Verixa's audit log is made tamper-**evident** by hash chaining: each event
commits to the hash of the one before it, so altering a past record breaks
every hash after it.

That's real protection, and it has one structural limit. The chain lives in
a database the operator controls. Someone with sufficient access to that
database can't quietly edit a single row — but they _can_ recompute the
entire chain from the point of alteration onward, producing a rewritten
history that is perfectly self-consistent. Hash chaining alone cannot tell
the two apart, because both live inside the same trust boundary.

Anchoring moves part of the proof outside that boundary. If the chain tip
was committed to a public ledger at a known time, a rewrite would also have
to alter a record the attacker doesn't control — and can't. The audit log
stays private in the operator's own database; only a hash goes public.

## Only ever anchor a hash

The adapter accepts nothing but a validated 64-character hex SHA-256
digest, and that restriction is deliberate rather than incidental.

A hash is a one-way commitment: it proves a record existed in a particular
state without revealing anything about what the record said. Audit logs
contain exactly the kind of data that must never be published — who
accessed what, when, from where. Putting any of it on a public ledger would
be an **irreversible** disclosure; there is no delete on Stellar.

So the rule is absolute: hashes only, never content.

## How it works

Anchoring submits a minimal Stellar transaction whose `MEMO_HASH` memo
_is_ the hash.

`MEMO_HASH` holds exactly 32 bytes — precisely the size of a SHA-256
digest, so the hash goes in whole, with no truncation or encoding
workaround. The transaction also carries a one-stroop self-payment, because
a transaction needs at least one operation in order to carry a memo, and a
self-payment of the smallest representable amount is the least consequential
operation available: it moves no value anywhere and leaves no lasting
state. (`manageData` would also work, but it creates a permanent account
data entry that raises the account's minimum balance requirement.)

Verification reads the transaction back from Horizon, decodes the memo, and
compares it to the expected hash.

### Why no smart contract

The entire requirement is "record 32 bytes on an append-only public ledger,
cheaply, and read them back." Stellar does that natively. A Soroban
contract would add a deployment to manage, an upgrade path to reason about,
and on-chain logic to audit — for no additional capability. Less surface is
better, particularly in a security-critical subsystem.

## Usage

```ts
import {
  KmsTransactionSigner,
  LocalTransactionSigner,
  StellarHashAnchor,
} from "@verixa/stellar-anchor";

// Development and testnet: the key is in this process's environment.
const anchorSecretKey = process.env.STELLAR_ANCHOR_SECRET_KEY;
if (anchorSecretKey === undefined) {
  throw new Error("STELLAR_ANCHOR_SECRET_KEY is not set");
}
const signer = new LocalTransactionSigner(anchorSecretKey);

// Production: the key never enters this process. `kmsClient` is the seam in
// `infrastructure/signing/kms-sign-client.ts` — implement it over your cloud
// KMS/HSM SDK and pass it here.
// const signer = new KmsTransactionSigner({
//   client,                    // your KmsSignClient over the cloud SDK
//   keyId: "alias/verixa-anchor",
//   accountId: "G...",         // the account that key signs for
// });

const anchor = new StellarHashAnchor({ signer, network: "testnet" }); // or "public"

const result = await anchor.anchor(chainTipHash);
// Result.ok({ hash, anchorRef, anchoredAt, network })
// anchorRef is the Stellar transaction hash — store it alongside the anchored range.

const verified = await anchor.verify(chainTipHash, anchorRef);
// Result.ok(true) if the transaction really does commit to that hash.
```

Both methods return `Result` rather than throwing: a scheduled anchoring job
that can't reach the ledger should log and retry on the next tick, not
crash. See [`error-handling.md`](./error-handling.md).

The `signer` is optional, and omitting it is meaningful rather than a
default: you get an adapter that can `verify` and refuses to `anchor`. The
two halves have different credential needs — verification reads public
ledger data and should work with nothing configured at all.

Where signing happens is a deployment decision, taken through
`TransactionSigner` rather than here. See
[`stellar-key-management.md`](../security/stellar-key-management.md) for why
a key in the process environment was removed as the only option.

### From the command line

```bash
# Anchor (needs a funded account, and is a development path — see below)
STELLAR_ANCHOR_SECRET_KEY=... STELLAR_NETWORK=testnet \
  pnpm --filter @verixa/stellar-anchor anchor <sha256-hex>

# Verify — no credentials, no funded account, reads public ledger data only
STELLAR_NETWORK=testnet \
  pnpm --filter @verixa/stellar-anchor anchor verify <sha256-hex> <tx-hash>
```

The CLI reads the key from the environment because a testnet experiment
should not require a KMS. It refuses to sign on the public network unless
`STELLAR_ALLOW_LOCAL_SIGNING=1` says otherwise. Production anchoring goes
through the API's composition root, where a KMS-backed signer is wired.

The verification half is the point. An integrity guarantee only the operator
can check isn't much of a guarantee — an auditor, a regulator, or a
suspicious user needs to confirm the commitment _without_ trusting the
operator's systems. Verification requires no secret key and no access to
Verixa at all, which is what makes the claim meaningful.

## The port, and staying optional

`HashAnchor` is a port. Nothing in its interface mentions Stellar:

```ts
interface HashAnchor {
  anchor(hash: string): Promise<Result<AnchorReceipt, AnchorError>>;
  verify(hash: string, anchorRef: string): Promise<Result<boolean, AnchorError>>;
}
```

Two implementations ship today: `StellarHashAnchor`, and
`InMemoryHashAnchor` for tests. The in-memory one doubles as the
"anchoring disabled" option — a deployment that wants Verixa's audit log
with no blockchain dependency at all can wire it in and lose nothing else.
Anchoring strengthens the integrity guarantee; it is never load-bearing for
authentication, authorization, or any other core function.

## Testing

Both implementations must pass the same behavioral contract
(`hashAnchorContract`), following the same one-suite-many-implementations
approach the repository ports use — see [`testing.md`](./testing.md).

That matters more here than usual. Almost every other test that touches
anchoring will run against the in-memory fake, so "the fake behaves like
the real ledger" is load-bearing. If `verify` returned `true` for a
non-matching hash in one implementation and `false` in the other, every
test built on the fake would be quietly meaningless.

```bash
pnpm --filter @verixa/stellar-anchor test          # fast, hermetic, no network
pnpm --filter @verixa/stellar-anchor test:testnet  # real Stellar testnet
```

The testnet suite is excluded from the default run (it needs network access
and takes tens of seconds) and has its own config file — Vitest applies
`exclude` even to explicitly named files, so there's no way to opt one back
in from the command line alone.

It generates a throwaway keypair, funds it from friendbot, and submits real
transactions. What it buys is the one thing the fake structurally cannot
prove: that the Stellar mechanics themselves are right — that a 32-byte
`MEMO_HASH` really does round-trip through submission and Horizon retrieval
unchanged.

One detail worth knowing if you run it: friendbot returns HTTP 200 as soon
as it has _submitted_ the funding transaction, which is a moment before the
new account is queryable. Building a transaction immediately after that 200
intermittently fails with "account not found." The suite polls until the
account resolves rather than sleeping a fixed interval — it's a real race,
not flakiness to paper over.

## Operational notes

Enabling anchoring in production needs:

- **A funded Stellar account.** Fees are negligible (100 stroops, or
  0.00001 XLM, per transaction — anchoring hourly costs a fraction of a
  cent per year), but the account must exist and stay funded.
- **A key-management story.** The anchoring key signs transactions that spend
  from a real account and mint publicly-verifiable claims, so whoever holds
  it can drain that account and forge anchors. `STELLAR_ANCHOR_SECRET_KEY`
  (via `LocalTransactionSigner`) is the development path; production is
  expected to wire a `KmsTransactionSigner` through
  `STELLAR_SIGNING_BACKEND=kms`, so the private half never exists in this
  process. See
  [`stellar-key-management.md`](../security/stellar-key-management.md), and
  for the mainnet-specific steps
  [`stellar-mainnet-cutover.md`](../runbooks/stellar-mainnet-cutover.md).
- **An anchoring interval decision.** Too frequent wastes fees for
  negligible added integrity — the hash chain already covers per-event
  tampering, and anchoring the tip transitively anchors everything before
  it. Too infrequent widens the window in which a rewrite would go
  undetected by external anchoring specifically. This is a genuine
  trade-off with no universally correct answer.

## Status

The adapter, the port, the in-memory fake, the shared contract suites
(`HashAnchor` and `TransactionSigner`), and the CLI are implemented, and the
Stellar mechanics are tested against the live testnet.

On the consuming side, `packages/audit` now exists: `AnchorAuditLog` anchors
a hash chain and records the receipt, and `pnpm --filter @verixa/audit demo`
runs the whole path end to end against testnet.

What's **not** built is the scheduler. Nothing calls `AnchorAuditLog` on an
interval — the deployment that wants periodic anchoring runs it from its own
cron, and `AnchorAuditLog` is written to be safe to invoke that way. Deciding
the interval is an operator's call, not a library default; see the trade-off
above.
