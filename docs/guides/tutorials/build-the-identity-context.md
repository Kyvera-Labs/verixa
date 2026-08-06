# Tutorial: Building the Identity Context (Issues 021–039)

This walkthrough traces one complete slice of Verixa — the Identity bounded
context — from a single validated string up to a tested, documented,
lint-enforced package. It's written for a contributor who's comfortable
with TypeScript but new to Domain-Driven Design and Clean Architecture in
practice: every stop points at real files in this repository, not
pseudocode, and explains the _why_ behind each layer before moving to the
next.

If you only read one thing before contributing to Verixa, read this.

## The map

Everything below lives under `packages/identity/`, which follows the same
internal shape every bounded-context package in Verixa uses:

```
packages/identity/
├── domain/           # entities, value objects, domain events — no framework, no I/O
├── application/       # use cases (orchestration) and ports (interfaces for persistence)
├── infrastructure/     # adapters implementing those ports — testing fakes for now, Prisma in Phase 03
└── index.ts            # the curated public surface — see the last stop below
```

The dependency rule: `application` depends on `domain`; `infrastructure`
depends on `application`'s ports (implements them); nothing in `domain`
depends on anything else in this list. Keep that rule in your head as you
read — it's why the tour below moves inward-out, from the most independent
layer to the most dependent.

## Stop 1 — A value object: `Email` (Issue 021)

Start at `packages/identity/domain/value-objects/email.ts`.

```ts
const email = Email.create("Alice@Example.com");
// Result<Email, ValidationError> — normalized to "alice@example.com",
// or an Err if the string isn't a valid address
```

The core idea: a bare `string` field for an email address means every
piece of code that touches it has to remember (or forget) to check "is this
actually valid." `Email` makes that impossible to forget — there is no way
to get an `Email` instance except through `create()`, which validates and
normalizes once, at the boundary. Read `email.spec.ts` alongside it: notice
the tests cover normalization (`Alice@Example.com` → `alice@example.com`)
and equality (`equals()`, not `===`) as much as rejection.

**Read next:** `display-name.ts` and `person-name.ts` (Issue 022) — the
same pattern applied twice more, with `person-name.ts` worth a close look
for what it _doesn't_ validate (no required family name, no Latin-charset
restriction) and why — see `docs/guides/domain-modeling.md`'s
internationalization section.

## Stop 2 — An aggregate root: `User` (Issue 023)

Now `packages/identity/domain/entities/user.ts`. This is a bigger jump than
value object → value object: `User` is an **aggregate root** — it has its
own identity (`UserId`, a branded ID — see `docs/guides/domain-modeling.md`
if you haven't read about branded identifiers yet) and a lifecycle
(`pending → active → suspended → deleted`) that only certain transitions
can legally make.

Look at `ALLOWED_TRANSITIONS` first — a table naming every legal status
change, checked in one place (`transitionTo`), rather than each method
independently deciding whether it's allowed to run. Then look at how a
`User` is constructed: `register()` for a brand-new user, `reconstitute()`
for rebuilding one from already-trusted data (a database row, once Phase 03
exists) — notice `reconstitute` skips transition validation entirely,
because loading a fact that's already true isn't the same operation as
making a new transition happen.

Notice, too, that every mutating method (`activate()`, `suspend()`,
`updateProfile()`) returns a **new** `User` instance rather than mutating
`this`. `user.spec.ts` tests this directly — check the test that asserts
`updatedAt` changes on a successful transition, and the ones asserting an
illegal transition is rejected (`rejects suspending a pending user
directly`).

## Stop 3 — Domain events: `UserRegistered` (Issues 026–027)

Open `packages/shared-kernel/domain/domain-event.ts` first — the generic
`DomainEvent`/`BaseDomainEvent` mechanism every context uses — then
`packages/identity/domain/events/user-registered.ts`, a two-line concrete
event built on top of it.

The question worth sitting with here: why does `User.register()` _record_
an event instead of directly notifying whatever might care (an audit log,
a welcome email)? Because identity doesn't know what might care, and
shouldn't have to. `docs/guides/domain-events.md` covers this in depth
("Why aggregates emit events instead of calling other contexts directly")
— read it before moving on, it's one of the more important architectural
ideas in this codebase.

Then look at `pullDomainEvents()` on `User` and its test in
`user.spec.ts` (`records a UserRegistered event on registration`). Notice
it's a plain read, not a destructive "clear" the way classic DDD examples
do it — `docs/guides/domain-events.md` explains why that's fine given
`User`'s immutable design.

## Stop 4 — A port: `UserRepository` (Issue 028)

`packages/identity/application/ports/user-repository.ts` is just an
interface — four methods, no Prisma, no SQL, nothing that says how a
`User` actually gets persisted. This is **ports & adapters** (hexagonal
architecture): the application layer declares _what_ it needs from
persistence; something else, later, decides _how_.

Why does this matter enough to be its own file, its own stop on this tour?
Because it's what makes the next stop testable without a database.

## Stop 5 — A use case: `RegisterUser` (Issue 030)

`packages/identity/application/use-cases/register-user.ts` is the first
place in this tour where multiple pieces come together: it takes a
`UserRepository` (the port from Stop 4) in its constructor, and its
`execute()` method validates input using `Email`/`DisplayName` (Stop 1),
checks uniqueness against the repository, and constructs a `User` (Stop 2)
if everything checks out.

Read `docs/guides/use-cases.md` for the full shape every use case in this
codebase follows — one class, one public `execute` method, a command object
in, a `Result` out. Then open `register-user.spec.ts` and notice what it
_doesn't_ need: no database, no HTTP server, no test containers. It
constructs an `InMemoryUserRepository` (Stop 6) and passes it straight to
`RegisterUser`'s constructor.

**Read next, in the same directory:** `update-user-profile.ts` (Issue 032,
partial updates + error aggregation), `suspend-user.ts`/`reactivate-user.ts`
(Issue 033, admin actions with a required reason), `create-organization.ts`
(Issue 034, the first use case spanning two aggregates), and
`invite-user-to-organization.ts` (Issue 035, a domain skeleton built ahead
of its delivery mechanism). Each is a variation on the same shape — see
`docs/guides/use-cases.md` for what's different about each one and why.

## Stop 6 — A fake adapter and a contract test (Issue 031)

`packages/identity/infrastructure/testing/in-memory-user-repository.ts`
implements the `UserRepository` port from Stop 4 using nothing but a
`Map`. This is the **adapter** half of ports & adapters — same interface,
totally different (and much simpler) technology than what Phase 03's real
Prisma-backed adapter will use.

The more interesting file is next to it:
`infrastructure/testing/contracts/user-repository.contract.ts`. It's not a
`.spec.ts` file — it exports a plain function,
`userRepositoryContract(createRepository)`, that runs a fixed set of
behavioral assertions against whatever repository the factory returns.
`repository-contract.spec.ts` calls it today against the in-memory fake;
when Phase 03 builds the real adapter, its test file will call the exact
same function against a real, database-backed repository. Both
implementations get proven to behave identically — not just "compiles
against the same interface." Read `docs/guides/testing.md`'s "Contract
testing" section for the full reasoning.

## Stop 7 — Closing the loop: the public surface (Issue 038)

Last stop: `packages/identity/index.ts`. Every file this tour visited lives
under `domain/`, `application/`, or `infrastructure/` — none of that is
meant to be imported directly from outside this package. `index.ts` is the
package's entire public contract, curated by hand.

Try it yourself: open any file outside `packages/identity/` and attempt
`import { User } from "@verixa/identity/domain/entities/user.js";`. Run
`pnpm lint`. You'll get a `no-restricted-imports` error pointing you back
at `@verixa/identity`. That's not a convention — it's
`eslint.config.mjs` enforcing it, so a refactor inside `domain/` can never
silently break a consumer that was never supposed to depend on it. See
`docs/guides/domain-modeling.md`'s "Package encapsulation" section.

## Exercise

Pick one and actually do it — reading about a pattern and using it once are
different skills:

1. **Add a value object.** `Organization.name` is currently a validated
   plain `string` field, not its own value object (see
   `docs/guides/domain-modeling.md`'s "What belongs in a value object vs. a
   plain field" for why that was an acceptable choice at the time).
   Extract an `OrganizationName` value object following the `Email`/
   `DisplayName` pattern from Stop 1, wire it into `Organization.create`,
   and update `organization.spec.ts`.
2. **Add a use case.** Write a `DeleteUser` use case (there's no dedicated
   one yet — only the generic `User.delete()` transition exists at the
   domain layer). It should require a reason, following the
   `SuspendUser`/`ReactivateUser` pattern from Stop 5, and should reject
   deleting an already-deleted user with a clear error. Write its tests
   against `InMemoryUserRepository`, no database required.

Either exercise touches every layer this tour visited: a value object or a
use case, a domain event if you emit one, a port method if you need one,
and a test that never needs anything more than an in-memory fake. If you
can do one comfortably, you understand how this codebase is built.
