# Audit Log Integrity

How Verixa's audit log makes tampering visible, and — just as important — the
limit of what it can make visible.

Applies to `packages/audit`. Issues #128 (chaining under concurrency) and #134
(batched writes) both changed the append path, so this document states the
invariant the two of them have to preserve together.

## The threat being defended against

An audit log that is only rows in a table proves nothing against the adversary
it most needs to resist: someone with write access to that table. They can
delete the row recording what they did, or edit it, and no evidence of the
change remains.

The realistic versions of that adversary are an insider with database
credentials, a stolen service account, or an operator responding to an
incident by "tidying up" the history. Notably it is _not_ an external attacker:
someone who can write arbitrary rows can usually drop the table too.

So the goal is not to make tampering impossible. It is to make tampering
**leave a trace**.

## The mechanism

Each entry commits to the entry before it:

```text
hash = SHA-256( canonical form of
        ( sequence, action, actorId, subjectId, occurredAt,
          previousHash, metadata ) )
```

Removing or altering any entry therefore invalidates every hash after it, and
tampering stops being a one-row edit — it requires rewriting the log from that
point forward. `AuditLogEntry` exposes no update or delete path at all, so the
aggregate cannot edit itself into a consistent state.

`GENESIS_HASH` (sixty-four zeroes) occupies the predecessor position of the
first entry. Without it the first entry's hash would be computed over a
different shape than every other entry's and verification would need a special
case.

### Canonical serialization

The hash is reproducible only if the bytes it is taken over are fixed, so
`canonicalize()` is specified rather than incidental:

- **Field order is fixed by the code**, not by an object literal's property
  insertion order. `JSON.stringify` over an object would make the digest depend
  on how a particular entry happened to be constructed in JavaScript.
- **Metadata keys are sorted** before encoding, so `{a, b}` and `{b, a}` — the
  same data, inserted in a different order, possibly by a different version of
  the writer — hash identically.
- **Pairs are separated by `U+001F`** and fields by newline. Plain
  concatenation would let a value containing a separator produce the same bytes
  as a different, legitimate combination of fields. `docs/security` has no
  business containing ambiguity of that kind, and the unit test
  "does not let different field values collide through concatenation" pins it.
- **`occurredAt` is encoded as an ISO-8601 string**, so the digest is a function
  of the instant rather than of a locale or a `Date` implementation detail.

Verification re-derives the digest from the stored columns rather than reading
back the stored hash. A stored hash that is merely compared proves nothing:
whoever edited the row would edit the hash too.

## Verification

`verifyChain(entries)` walks a chain in sequence order and reports the **first**
break, with three distinct reasons because they mean different things:

| Reason            | What it means                                                             |
| ----------------- | ------------------------------------------------------------------------- |
| `content_altered` | The entry's own hash no longer matches its content — the row was edited.  |
| `link_broken`     | The entry is intact but does not follow its predecessor — a deletion.     |
| `sequence_gap`    | Numbering skips — a removal that fixed up the hashes but not the counter. |

Only the first break is reported because everything after one is unreliable
anyway; listing the knock-on failures would bury the single fact that matters
under noise it caused.

## The limit, stated plainly

Chaining makes the log tamper-evident to someone holding an earlier copy of a
hash. It does **not** make it tamper-proof.

An attacker with full write access can rewrite the chain from the point of
alteration onward and produce a history that is perfectly self-consistent.
`verifyChain` returns no break, and no amount of hashing fixes that: the whole
chain lives inside one trust boundary.

Closing that gap requires a commitment stored where the operator cannot rewrite
it, which is what anchoring the chain head to Stellar is for
([`docs/adr/0003-stellar-audit-anchoring.md`](../adr/0003-stellar-audit-anchoring.md)).
The two mechanisms are complementary and neither is sufficient alone. "We
hash-chain our audit log" is frequently claimed as though it were the whole
answer; it is half of one.

## Append serialization: the part that broke

A chain is a strictly serial structure. Every entry's hash depends on its
predecessor, so two entries built from the same predecessor are two different
chains claiming the same position, and only one of them can be the log.

That makes the append a compare-and-set rather than an insert: _add these
entries, if and only if the current head is the one they were built against._

### The protocol

`AuditLogRepository.append(entry, expectedPreviousHash)` and
`appendMany(entries, expectedPreviousHash)` return
`Result<void, ChainConflictError>`:

- The caller names the head its entries were built from.
- If the head has moved, nothing is written and the error carries both hashes —
  the expected one and the one actually found, which is what a retry needs.
- A batch is atomic. Half a chain landing is worse than none of it: it produces
  exactly the fork the protocol exists to prevent.
- `appendMany` also refuses a batch whose own entries do not chain, _before_
  touching the database. A batch assembled from two different reads would
  otherwise be discovered as a broken chain by the next person who tried to
  verify it.

`RecordAuditEvent` is where the _response_ to a conflict lives: re-read the
head, relink onto it, retry — bounded to three attempts. Retrying is safe
precisely because the losing append never landed; the retry completes the entry
the caller asked for rather than writing a second one. Giving up after three is
deliberate: an unbounded retry loop under sustained contention turns a
throughput problem into an outage. A missing audit entry is bad; a wedged
process is worse, and the gap is detectable either way.

### What actually serializes

**The unique index on `sequence`, not the transaction.** This is the
non-obvious part and it is worth understanding before changing anything.

The compare-and-set is a read plus an insert inside one transaction. At
Postgres' default `READ COMMITTED` isolation, two overlapping transactions can
both read the same head — a transaction gives you a consistent _snapshot_, not a
lock on a row you have not inserted yet. The in-transaction re-check is
best-effort and cheap; the index is the real gate. Whichever writer commits
second raises `P2002`, which the adapter translates into the same
`ChainConflictError` a failed check would have produced. Callers cannot tell the
two apart and should not need to.

`tests/integration/audit-chain-concurrency.spec.ts` exists specifically to keep
that claim honest against a real Postgres, and
`prisma-audit-repositories.spec.ts` keeps it honest against the fake that
emulates the index.

### Rejected: computing the hash inside the repository

The alternative reading of "the hash is computed in the same transaction as the
insert" is to move `AuditLogEntry.append()`'s hashing into
`PrismaAuditLogRepository`, so the adapter derives the digest after reading the
head.

Rejected, for three reasons:

1. **It puts a domain rule in an adapter.** Which fields are hashed, in what
   order, with what separators _is_ the integrity guarantee. Living in a
   database adapter, it becomes a property of one deployment choice rather than
   of the log, and any second adapter has to reproduce it correctly to avoid
   corrupting the chain. The repository layering rule in
   `docs/guides/domain-modeling.md` exists for exactly this.
2. **It does not buy what it appears to buy.** Serialisation comes from the
   index either way. Moving the hash computation inside the transaction changes
   nothing about who wins the race; it only changes where the digest is
   calculated.
3. **It cannot be tested without a database.** Hashing stays a pure function of
   the entity today, which is why canonical-form stability is covered by unit
   tests that run in milliseconds.

What the transaction _does_ contain is the head check and the insert, which is
the part that has to be atomic. The hash itself is derived from the predecessor
the caller already named, so computing it earlier is not a correctness hazard.

### Rejected: a lock, a queue, or a single writer

Advisory locks (`pg_advisory_xact_lock`) or a dedicated writer process would
make the read-and-insert genuinely atomic instead of relying on the loser to
retry. Both were rejected: a lock is a second coordination mechanism to operate
and to get wrong, and a single-writer queue would serialize the whole application
behind one table. The retry is cheap, it is already required for the batched
writer's flush, and the failure mode — a lost race — is indistinguishable from a
conflict the caller handles the same way.

## Batching and the chain

`BatchedAuditWriter` (Issue #134,
[`docs/performance/audit-write-throughput.md`](../performance/audit-write-throughput.md))
queues _unhashed intents_ and builds the chain at flush time from a head read
immediately beforehand.

That ordering is not an optimization detail; it is what keeps the chain legal.
If entries were hashed when queued, a batch would claim a predecessor that may
have moved by the time it flushed, and the whole batch would be a fork. Building
the chain as late as possible is the only point at which a batch and a chain can
coexist.

The chain remains strictly serial. What batching changes is the number of
round trips, which is the thing that actually costs.

## Operations

- **Verify regularly, not on demand.** A chain nobody checks is a chain nobody
  can prove. `AnchorAuditLog` commits the head externally; verification against
  an anchor is the only check that catches a wholesale rewrite.
- **A gap is an incident, not noise.** `RecordAuditEvent` never fails the
  operation it records, so a lost audit write surfaces as a `sequence_gap`
  later. That trade is documented in `docs/guides/error-handling.md` and in the
  use case's own comment; the mitigation is that the gap is _visible_.
- **`metadata` is a flat string map** by convention, not by schema. The `Json`
  column can hold anything. On read, non-string values are dropped rather than
  coerced, so a hand-edited row produces an entry whose hash does not verify —
  which is what should happen — instead of crashing during verification.
- **The chain is per deployment, not per organization.** Organization scoping
  was considered and left out: it needs a schema change and a migration, and
  mixing chains would mean every reader had to know which chain a row belongs
  to before it could verify anything. Noted here so the omission reads as a
  decision rather than an oversight.

## Related

- [`docs/adr/0003-stellar-audit-anchoring.md`](../adr/0003-stellar-audit-anchoring.md)
- [`docs/security/stellar-key-management.md`](./stellar-key-management.md)
- [`docs/performance/audit-write-throughput.md`](../performance/audit-write-throughput.md)
- [`docs/guides/domain-modeling.md`](../guides/domain-modeling.md)
- [`docs/guides/testing.md`](../guides/testing.md)
