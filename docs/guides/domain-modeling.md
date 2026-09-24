# Domain Modeling Conventions

This guide collects the recurring patterns used to model Verixa's domain
layer. It grows as later phases add value objects, entities, and aggregates —
for now it covers the first building block: branded identifiers.

## Branded identifiers

`@verixa/shared-kernel` exports `Id<Brand>`, a UUID string carrying a
compile-time-only "brand":

```ts
import { createId, type Id } from "@verixa/shared-kernel";

type UserId = Id<"UserId">;
type OrganizationId = Id<"OrganizationId">;

const userId: UserId = createId<"UserId">();
```

### Why not just use `string`?

This is the "primitive obsession" anti-pattern: using a general-purpose
primitive (`string`, `number`) to represent something with much narrower,
specific meaning (a user's identity). The problem isn't that it's wrong, it's
that the type system stops helping you:

```ts
function transferOwnership(userId: string, organizationId: string): void { ... }

// Both compile without complaint. Only one is correct.
transferOwnership(user.id, org.id);
transferOwnership(org.id, user.id); // arguments swapped — silent bug
```

Branding turns that into a compile-time error instead of a runtime one:

```ts
function transferOwnership(userId: UserId, organizationId: OrganizationId): void { ... }

transferOwnership(org.id, user.id); // Type error: OrganizationId is not assignable to UserId
```

### Nominal vs. structural typing

TypeScript's type system is _structural_ by default: two types are compatible
if their shapes match, regardless of name. That's usually a feature (it makes
duck typing and interface composition easy), but it's exactly what causes the
`UserId`/`OrganizationId` mix-up above — both are plain `string`s, so
structurally they're identical.

Branding is how you opt into _nominal_ typing (where names, not just shapes,
matter) for the specific cases where it's worth it. The `Branded<T, Brand>`
helper attaches a `unique symbol`-keyed property that only exists in the type
system, never at runtime:

```ts
type Branded<T, Brand extends string> = T & { readonly [brand]: Brand };
```

Because the branding property is declared with a `unique symbol` no other
code can produce, the only way to get a value typed as `Id<"UserId">` is to go
through `createId<"UserId">()` or `asId<"UserId">(value)` — a plain string
literal is never assignable, which is exactly what the `@ts-expect-error`
tests in `branded-id.spec.ts` verify.

### `createId` vs. `asId`

- **`createId<Brand>()`** generates a brand-new random UUID (via Node's
  built-in `crypto.randomUUID()`) — use this when creating a new entity.
- **`asId<Brand>(value)`** brands a string you already have (typically one
  read back from a database row) — it performs no validation, so only use it
  on values you already trust.

### Convention going forward

Every aggregate gets its own id brand named after the entity, e.g. `UserId`,
`OrganizationId`, `SessionId`. These are declared alongside the entity itself
(starting with `User` in Phase 02), not centrally in `shared-kernel` — the
shared kernel only owns the generic `Id<Brand>` mechanism.

## Value objects

`packages/identity/domain/value-objects/` (`Email`, `DisplayName`,
`PersonName`) are the first concrete example of a recurring pattern: wrap a
primitive that has domain-specific validity rules in a small immutable class
with a private constructor, so the _only_ way to get an instance is through a
static factory that enforces those rules:

```ts
class Email {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Email, ValidationError> {
    // normalize + validate, return Result.err on failure
  }
}
```

This is the same "primitive obsession" problem branded IDs solve (see above),
applied to values rather than identifiers: a bare `string` field for an email
address lets every layer that touches it re-derive (or forget to derive)
"is this actually valid," and lets an unrelated string be passed where an
email was expected. An `Email` value can only exist already-validated —
there is no code path that produces one without going through `create()`.

Two value objects are equal if their normalized values are equal, not if
they're the same object reference (`equals()`, not `===`) — value objects
are compared by value, which is the property that gives them their name.

### What belongs in a value object vs. a plain field

Not every field needs to be a value object — the bar is "does this have
validation or normalization rules that would otherwise be duplicated or
forgotten." `Organization`'s `slug` has real validation rules (URL-safe,
length-bounded) but is currently kept as a validated `string` field on the
entity rather than its own `Slug` class, since (unlike `Email`) nothing else
in the domain needs to construct or compare a slug independently of an
`Organization`. Promote a field to its own value object once a second
independent use appears — not preemptively.

### Internationalization pitfalls in name validation

`PersonName` deliberately does not require a `familyName`, and doesn't
restrict either name part to a Latin charset. Two common mistakes this
avoids: assuming every person has both a given and a family name (many
cultures use a single mononym, or list family name first with no separator
Western code tends to assume), and validating names against an ASCII/Latin
pattern (which silently rejects real names containing accented characters,
CJK characters, or other non-Latin scripts). `DisplayName` follows the same
principle — it constrains length, not charset.

## Aggregates and invariant enforcement

`User`, `Organization`, and `OrganizationMembership`
(`packages/identity/domain/entities/`) are **aggregate roots**: entities with
their own identity (a branded `Id`) and lifecycle, constructed only through a
static factory (`register`/`create`) that enforces every invariant the type
system alone can't — a `User` cannot exist with an invalid status, an
`Organization` cannot exist without exactly one owner, an
`OrganizationMembership` cannot be created as a duplicate active membership
for the same user+organization pair.

### Status transitions as an explicit table, not scattered `if`s

`User.ALLOWED_TRANSITIONS` names every legal status change up front
(`pending → active`, `active → suspended`, `suspended → active`,
any-non-deleted `→ deleted`) rather than relying on each transition method
independently checking "am I allowed to do this right now." This makes an
illegal transition (reactivating a `deleted` user) a property of the table,
checkable and testable in one place, instead of a rule that could be
correctly enforced in one method and forgotten in the next one added later.

### Why entities are immutable

`User`, `Organization`, and `OrganizationMembership` never mutate their own
fields — `activate()`/`suspend()`/`revoke()` all return either a new instance
(via `Result<T, E>`, since a transition can fail) or, for the idempotent
`revoke()` case, the same instance unchanged. This mirrors the value-object
pattern above and for the same underlying reason: a reference to a `User`
can't silently go stale or get mutated out from under other code holding the
same reference — every state change is a new, explicit value.

### Why other contexts reference `UserId`, not `User`

Only the identity context ever holds a `User` instance. Every other bounded
context (audit, sessions, verification, ...) stores and passes around
`UserId` alone. This is the same coupling argument as branded IDs generally,
one level up: if the audit context held a live `User` reference, it could
reach into identity's internals (or accidentally depend on invariants that
only identity is responsible for maintaining) instead of going through
identity's own public API when it actually needs user data. Referencing by
ID keeps the dependency one-directional and explicit.

### `register`/`create` vs. `reconstitute`

Every aggregate has two construction paths: `register`/`create` (a _new_
aggregate, which runs full validation and assigns a fresh ID) and
`reconstitute` (rebuilding an aggregate from data that's already
trusted — a database row, once Phase 03 adds persistence). `reconstitute`
skips validation deliberately: the data it's given already represents a
previously-valid state, so re-validating it as if it were new user input
would be redundant at best and, for status transitions specifically, wrong
(reconstituting a `deleted` user isn't "transitioning to deleted," it's
loading a fact that's already true).

### Multi-tenancy modeling: why `OrganizationMembership` is its own entity

`OrganizationMembership` links a `UserId` to an `OrganizationId`, but it's
modeled as its own entity with an ID and a status, not a plain
`{ userId, organizationId }` pair — because membership itself has behavior
(it can be revoked; a revoked membership doesn't block rejoining, but an
active one blocks a duplicate) that a bare join table can't express without
pushing that logic somewhere else. This previews the broader multi-tenancy
question `planning/ARCHITECTURE.md` §8 discusses: organizations, membership,
and (starting Phase 07) role assignment are kept as separate, composable
concepts rather than one wide "user-org-role" record, so each can evolve
independently.

## Ports & adapters (hexagonal architecture)

`packages/identity/application/ports/` defines three interfaces —
`UserRepository` (`findById`, `findByEmail`, `save`, `existsByEmail`),
`OrganizationRepository`, and `OrganizationMembershipRepository` — with no
reference to Prisma, SQL, or any other implementation detail. That's the
**port**: _what_ the application layer needs from persistence, decided
before _how_ it's provided. The concrete implementation (Phase 03,
Prisma-backed) will be an **adapter**: something that satisfies the port's
contract using a specific technology.

The dependency points one way: `application` defines the ports and depends
on nothing else; `infrastructure` (once it exists) depends on `application`
to implement them, never the reverse. This is what makes the domain and
application layers testable without a database (swap in an in-memory fake
that satisfies the same interface — see `register-user.spec.ts` for the
first example, and Issue 031 for the reusable version) and what makes
swapping persistence technology later a matter of writing a new adapter, not
rewriting use cases.

### Interface segregation: three ports, not one

Membership persistence (`OrganizationMembershipRepository`) is its own
interface rather than a few extra methods on `OrganizationRepository`,
following the **interface segregation principle**: a consumer that only
needs to check or list memberships shouldn't have to depend on (or, in
tests, fake out) an interface that also exposes organization
creation/lookup it never calls. Keeping ports narrow and focused makes each
one easier to fake completely in a test and easier to reason about in
isolation — the cost is more files, not more coupling.

## Designing forward-compatible domain models

`Invitation` (`packages/identity/domain/entities/invitation.ts`, Issue 035)
models a complete lifecycle — issued, single-use via a status transition
with no way back to `pending`, time-limited via `expiresAt` — for a feature
whose actual delivery mechanism (emailing the invitation) doesn't exist
until Phase 14. This is a deliberate technique, not scope creep: capture the
domain _intent_ (what an invitation is, what states it can be in, what
"accepting" means) as soon as enough is known to model it correctly, even
before every consumer of that model exists.

The alternative — waiting until Phase 14 to design `Invitation` alongside
the email adapter — risks shaping the domain model around the delivery
mechanism's constraints (e.g. treating an invitation as barely more than "an
email that got sent") instead of around what an invitation actually _is_.
Modeling it now, driven by Phase 02's org-membership concerns, keeps the
domain model the primary design driver; Phase 14 then only has to plug a
`send(invitation)` step into an already-correct lifecycle, not redesign one.

The tell for when this technique applies: you can already answer "what are
the valid states, and what causes each transition" with confidence, even if
"what happens when a transition fires" (send an email, call a webhook) isn't
built yet. If you can't yet answer the states/transitions question either,
that's a sign the feature isn't understood well enough to model — build the
simple version first.

## Package encapsulation as an enforced boundary, not just convention

`packages/identity/index.ts` (Issue 038) is the package's entire public
surface: every entity, value object, event, port, and use case another
package is meant to consume, curated by hand into one file. Nothing outside
`packages/identity` is meant to import a deep path like
`@verixa/identity/domain/entities/user.js` — only the barrel,
`@verixa/identity`.

A barrel file alone is a convention, not a boundary: nothing stops a
different package from reaching past it with a deep relative-looking import,
and conventions that aren't enforced tend to erode the first time someone's
in a hurry. `eslint.config.mjs` makes it a real boundary with a
`no-restricted-imports` rule (scoped to every file _except_
`packages/identity/**` itself, since the package's own internals legitimately
import each other by relative path) that blocks the `@verixa/identity/*`
pattern outright — attempting it is a lint error, not a review comment.

This matters architecturally, not just stylistically: it's what makes
`packages/identity/domain/entities/user.ts` genuinely internal. As long as
every external consumer goes through `index.ts`, that file's exports are
the _only_ contract other code depends on — internal refactoring (renaming
an internal helper, restructuring how `User` stores its fields) can never
break a consumer, because a consumer was never able to depend on internals
that weren't exported in the first place. Remove something from `index.ts`
and the compiler (and this lint rule) will tell you exactly what broke,
which is a much stronger guarantee than "we agreed not to do that."

## Use cases

The first concrete use case, `RegisterUser`
(`packages/identity/application/use-cases/register-user.ts`), establishes
the application layer's command-handler pattern: see
`docs/guides/use-cases.md` for the full shape and rationale.

## Sessions and expiry policies (Phase 05, Issue 083)

`Session` (packages/sessions/domain/entities/session.ts) is a stateful
aggregate representing an authenticated user's active session — a logical
unit distinct from the tokens issued from it. This separation of concerns
matters: a session has a lifecycle (active, revoked), an expiry policy, and
track records of activity (`lastSeenAt`), while tokens are the derived
artifacts presented to prove the session is valid.

### Why sessions exist separately from tokens

Many systems conflate "session" with "JWT token": the token is the session,
revocation is a deny-list, and activity tracking is implicit in token
reissuance. This works at small scale but breaks under real-world constraints:

- **Revocation latency:** A deny-list add takes time to propagate across a
  cluster; a request that arrives before the update still sees the token as
  valid. A stateful session loaded from a local (or locally-cached) database is
  more reliably revoked.
- **Multi-device accountability:** A user logs in on their phone, then again on
  a laptop. Did they? Or did an attacker? A deny-list can't tell — both tokens
  are equally revoked. A per-session record of device/IP/user-agent metadata
  makes the difference visible.
- **Concurrent-session limits:** "Let this user have at most 3 active sessions"
  is trivial with a per-session row (count rows, evict the oldest on overflow).
  It's complicated with tokens alone (no place to record which device is
  "oldest").

The architecture here separates the two: `Session` is the stateful record,
tokens are short-lived artifacts. Revocation revokes the session; the token's
deny-list is a short-lived performance optimization (a few minutes), not the
source of truth.

### Expiry policies and the sliding vs. absolute tradeoff

`SessionExpiryPolicy` (packages/sessions/domain/value-objects/session-expiry-policy.ts)
encodes the decision: does activity extend the expiry (`sliding`), or is there a
hard cutoff regardless of activity (`absolute`)?

- **Sliding:** A session with a 15-minute policy and one hour of continuous
  activity is never expired — the expiry window slides forward with each
  request. Seamless UX (no sudden logouts), but a compromised session token
  can live arbitrarily long under continuous (automated) reuse.
- **Absolute:** The session expires 24 hours after creation, regardless of
  activity. Guarantees a maximum lifetime, but the user is logged out the
  moment the window closes — mid-form, mid-API-call, with no recovery path.

Real deployments use both: absolute expiry on the refresh token (7 days,
hard boundary) and sliding expiry on the access token (15 minutes, extends
on use). This bounds the worst-case exposure of a stolen token (7 days max)
while keeping UX smooth (re-login only if idle 15+ minutes).

**Why this is a domain concern:** The choice is not a database implementation
detail; it's a security/UX policy that belongs to the session entity itself.
The entity's `isExpired()` and `touch()` methods must know which mode they're
in to compute correctly. This is why `SessionExpiryPolicy` is part of the
domain layer, not infrastructure.

**Why policies are not persisted:** The policy (mode and interval) is a
configuration decision, not a per-session value — all refresh tokens use the
same policy, all access tokens use the same policy. Storing it per-row wastes
space and creates a maintenance hazard (if the policy changes, do we update
stored rows?). Instead, it's supplied by the use case or composition root when
reconstructing a session from the database.

### Indexing strategy for "active sessions per user"

The database schema includes two indexes:

1. **(userId, expiresAt) composite:** Supports the core query pattern:
   "fetch all non-revoked, non-expired sessions for a user" (used by "list
   devices," concurrent-session-limit enforcement, "log out everywhere").
   Sorted on both columns means the query avoids a secondary sort and uses
   the index for both the user lookup and the expiry filter.

2. **expiresAt alone:** Supports the background expiry sweep (not built until
   later phases): "delete or archive all sessions where expiresAt < now()"
   without a sequential table scan.

These indexes were verified by `EXPLAIN ANALYZE` in the contract test suite
(prisma-session-repository.spec.ts), confirming that both query patterns use
index scans rather than sequential scans.

### Row-Level Security

Sessions belong to users, who belong to organizations. A session must never be
readable by a user in a different organization. This is enforced by Postgres
Row-Level Security (RLS) policies once Issue 052 is implemented. For now, it is
documented as a constraint; the policy itself is added when the RLS
infrastructure exists.

### Why contract testing matters for sessions

The `SessionRepository` port has two implementations: `InMemorySessionRepository`
(for unit tests and the initial phase) and `PrismaSessionRepository` (for
persistence). The same contract test suite (`session-repository.contract.ts`)
runs against both, ensuring they behave identically. This catches subtle bugs:
a query that accidentally includes revoked sessions, an expiry calculation that
drifts by milliseconds, a revoke operation that doesn't update lastSeenAt when
it should. The contract is the single source of truth about what "correct"
behavior is.

## Use cases

The first concrete use case, `RegisterUser`
(`packages/identity/application/use-cases/register-user.ts`), establishes
the application layer's command-handler pattern: see
`docs/guides/use-cases.md` for the full shape and rationale.
