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

## Use cases

The first concrete use case, `RegisterUser`
(`packages/identity/application/use-cases/register-user.ts`), establishes
the application layer's command-handler pattern: see
`docs/guides/use-cases.md` for the full shape and rationale.
