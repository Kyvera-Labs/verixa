# Testing the platform: from a unit test to an end-to-end journey

This tutorial walks a new contributor through every kind of test Verixa uses,
in the order you'll usually need them: a unit test, an integration test
against a real Postgres, a contract test that holds several adapters to one
specification, and an end-to-end journey through the running API. It ties
together the Phase 21 testing work, which is otherwise spread across a
handful of reference guides linked at the end.

Every code example on this page is imported from a real test file, so it is
exactly what `pnpm test` (or the named CI job) runs. On the docs site the code
appears inline. GitHub shows the import directive (`<<< @/…`) instead, so each
example is followed by a link to its source file. See
[Writing docs](../writing-docs.md#showing-real-code-snippet-imports) for why
the examples are imported rather than pasted.

## 1. Why the suite is shaped like a pyramid

Verixa's tests form the usual pyramid: many unit tests, fewer integration
tests, a handful of end-to-end tests. The shape follows from one constraint,
**how fast a test tells you that you broke something**:

| Kind        | Lives in                                                             | Needs                      | Runs in                               |
| :---------- | :------------------------------------------------------------------- | :------------------------- | :------------------------------------ |
| Unit        | `*.spec.ts` next to the code                                         | nothing                    | `pnpm test`                           |
| Integration | `packages/*/infrastructure/**/*.spec.ts`, `tests/integration/`       | Postgres (or Docker)       | `pnpm test`, skipped when no database |
| Contract    | `*.contract.spec.ts`, `packages/*/infrastructure/testing/contracts/` | whatever its adapters need | `pnpm test`                           |
| End-to-end  | `tests/e2e/`                                                         | Docker and a built API     | the `e2e` CI job, not `pnpm test`     |

A unit test runs in milliseconds and its failure names the rule that broke.
An end-to-end test takes a container start and tells you only that _something_
on the path failed. So business rules are tested as low in the pyramid as they
can be caught, and each layer up tests only what the layers below it can't
see: SQL and constraints for integration tests, adapter interchangeability for
contract tests, process startup and real HTTP for end-to-end tests.

Database-backed tests **skip** when no Postgres is reachable, so a fresh clone
with no Docker still gets a green `pnpm test`. CI sets
`REQUIRE_DATABASE_TESTS=1`, which turns that skip into a failure, so the
coverage can't silently disappear from the pipeline.

The rejected alternative is to test mostly through the HTTP API, since that's
"what users see". Those tests are honest but slow, they need Docker on every
machine, and a failure points at a route, not a rule. They also can't reach
states a public endpoint can't produce, which is where most security bugs
live.

TODO(link): the performance budget guide (Issue 415,
`docs/guides/testing/performance-budget.md`) sets how fast each layer must
stay. It isn't on `main` at this revision; link it here once it lands.

## 2. A unit test, with a builder

A unit test exercises one use case or entity against in-memory fakes. Here is
the `ApproveVerification` use case, with its precondition (a verification
request a reviewer has claimed) built by a test data builder:

<<< @/../tests/examples/approve-verification.spec.ts#unit-test{ts}

Source: [`tests/examples/approve-verification.spec.ts`](../../../tests/examples/approve-verification.spec.ts)

What to take from it:

- **Everything comes from the package root**, `@verixa/testing-kit`. The
  builders, factories, fakes and clocks are its public API, and a lint rule
  rejects deep imports such as `@verixa/testing-kit/builders/...` from outside
  the package (see section 7).
- **The arrange step reads as the precondition.** `.inReview().claimedBy(...)`
  is replayed through the aggregate's own transitions, so the request is
  domain-valid by construction, and an impossible chain such as approving
  without a claim throws the domain's error at `build()`. Compare it with the
  hand-unwrapped `inReview()` helper in the use case's own
  [spec](../../../packages/verification/application/use-cases/approve-verification.spec.ts).
  [Builders for field-heavy aggregates](../testing/unit-test-conventions.md#builders-for-field-heavy-aggregates)
  covers when to choose a builder over a plain factory.
- **Time is injected.** `FixedClock` supplies `now`, so nothing depends on
  when the suite runs.
- **The assertion is on behavior** (the result, and what the repository now
  holds), not on how the use case got there.

This example lives in `tests/` because `@verixa/testing-kit` depends on every
context package, so a context package can't depend back on it without a
cycle. Inside a context package, the same test uses that package's own fakes
and constructors. That's how the existing `approve-verification.spec.ts` is
written.

Run it with:

```sh
pnpm --filter @verixa/integration-tests exec vitest run examples
```

The [unit test conventions](../testing/unit-test-conventions.md) (Issue 401)
are the reference for naming, arrange-act-assert, mocking at boundaries and
time-dependent code.

## 3. An integration test against real Postgres

The in-memory fakes make unit tests fast, but they can't check SQL, foreign
keys or a unique index. Integration tests run the real Prisma adapters against
a real Postgres. The identity package's harness gets one in either of two
ways:

1. **An existing database** named by `TEST_DATABASE_URL`. CI's service
   container and a local `docker compose up -d postgres` both take this path,
   which is fastest because nothing has to start.
2. **A Testcontainers-managed container** when nothing is configured but
   Docker is available. It is started per run, migrated, and destroyed:

<<< @/../packages/identity/infrastructure/testing/database-harness.ts#testcontainers{ts}

Source: [`packages/identity/infrastructure/testing/database-harness.ts`](../../../packages/identity/infrastructure/testing/database-harness.ts)

The schema comes from `prisma migrate deploy`, not `db push`. `db push` is
faster, but it builds the schema straight from `schema.prisma`, so a broken
migration would still pass. Replaying the real migrations tests the schema
production gets.

An integration test should assert what only a database can guarantee. This
one proves a partial unique index holds even when two writers race past the
application-level check:

<<< @/../packages/identity/infrastructure/persistence/prisma-repositories.spec.ts#database-invariant{ts}

Source: [`packages/identity/infrastructure/persistence/prisma-repositories.spec.ts`](../../../packages/identity/infrastructure/persistence/prisma-repositories.spec.ts)

The spec obtains its database once at module level
(`const database = await startTestDatabase()`) and wraps everything in
`describe.skipIf(database === undefined)`. Run it with Docker running, or with
`docker compose up -d postgres` and `TEST_DATABASE_URL` set:

```sh
pnpm --filter @verixa/identity run test
```

In CI, the `testcontainers` job runs the identity and authorization suites
this way, and the `ci` job runs `tests/integration/` against its Postgres
service. [Testing](../testing.md) describes the HTTP integration harness used
in `tests/integration/`.

## 4. A contract test: one suite, every adapter

A port can have several adapters: an in-memory fake, a static stub, an HTTP
client, a Prisma repository. TypeScript checks that they share a shape. A
contract test checks that they share _behavior_, by running one set of
assertions against each of them. `defineContractTests` from
`@verixa/testing-kit` takes named factories and a spec:

<<< @/../packages/rate-limiting/infrastructure/testing/geo-ip-resolver.contract.spec.ts#contract{ts}

Source: [`packages/rate-limiting/infrastructure/testing/geo-ip-resolver.contract.spec.ts`](../../../packages/rate-limiting/infrastructure/testing/geo-ip-resolver.contract.spec.ts)

The spec receives a getter, not an adapter. Each test gets a fresh instance
from its factory in `beforeEach`, so a stateful adapter can't carry state from
one assertion into the next. The same file goes on to assert the _failure_
modes (timeout, malformed response, service unavailable) map to the same
errors across adapters, because callers depend on those too.

Persistence contracts use the same idea with a plain function per port. The
identity package runs one suite against its in-memory fakes in
[`repository-contract.spec.ts`](../../../packages/identity/infrastructure/testing/repository-contract.spec.ts)
and the same suite against Prisma inside the integration spec from section 3:

<<< @/../packages/identity/infrastructure/persistence/prisma-repositories.spec.ts#real-database-contract{ts}

That pairing is what makes the unit tests above trustworthy: a use-case test
written against `InMemoryUserRepository` only means something if the fake
behaves like the real repository, and this proves it does.

[Contract tests for ports](../testing/contract-tests.md) (Issue 409) has the
coverage checklist for which ports have contracts, and how to write a new one.

## 5. An end-to-end journey

The end-to-end suite starts the **compiled** API as a child process, with
disposable Postgres and Redis containers, and talks to it over real HTTP. It
catches what no in-process test can: environment parsing, startup, listener
binding and the network boundary.

<<< @/../tests/e2e/health.spec.ts#e2e-journey{ts}

Source: [`tests/e2e/health.spec.ts`](../../../tests/e2e/health.spec.ts)

At this revision the suite has a single journey: the process starts and
answers `/health` and `/version`. That's deliberately small. It's the
prerequisite for broader flows, and business rules belong lower in the
pyramid. Run it after a build, with Docker available:

```sh
pnpm build
pnpm --filter @verixa/integration-tests run test:e2e
```

`pnpm test` excludes this suite. If it skipped silently without Docker, it
would claim confidence it didn't earn, so CI runs it in its own `e2e` job.
[End-to-end suite](../testing/e2e-suite.md) explains the harness.

## 6. Snapshot tests for response shapes

TODO(link): the snapshot testing conventions (Issue 418,
`docs/guides/testing/snapshot-testing.md`) aren't on `main` at this revision,
and the repository has no snapshot tests yet. Link the guide here and add an
example once that work lands, rather than inventing a convention ahead of it.

## 7. What testing-kit exports

`packages/testing-kit/index.ts` is the package's whole public API. Every name
is listed explicitly, and `packages/testing-kit/index.spec.ts` checks with the
repository's real ESLint configuration that a deep import from outside the
package is rejected.

- **Builders** (section 2;
  [Builders for field-heavy aggregates](../testing/unit-test-conventions.md#builders-for-field-heavy-aggregates)):
  `aCredential`, `aPendingInvitation`, `anMfaMethod`, `aVerificationRequest`,
  and their `…Builder` types.
- **Factories** ([Fixtures and Object Mothers](../testing/unit-test-conventions.md)):
  `makeAuditEvent`, `makeCredential`, `makeInvitation`, `makeMfaMethod`,
  `makeOrganization`, `makeOrganizationMembership`, `makeRefreshToken`,
  `makeSession`, `makeUser`, `makeVerificationRequest`, and their
  `…FactoryOptions` types.
- **Fakes** (section 2;
  [the fake registry](../testing/unit-test-conventions.md) lists them by
  context): the `InMemory…` adapters for identity, sessions, credentials, MFA,
  authorization, audit, verification, the shared kernel and the Stellar anchor,
  plus `InMemoryRateLimiter`, `InMemoryCaptchaValidator` and
  `NoopCaptchaValidator`; types `ResettableFake` and `CaptchaValidator`.
- **Contract tests** (section 4; [Contract tests for ports](../testing/contract-tests.md)):
  `defineContractTests`; types `ContractImplementation` and `ContractSpec`.
- **Determinism** (section 2;
  [Time, randomness, and asynchronous work](../testing/unit-test-conventions.md#time-randomness-and-asynchronous-work)):
  `FixedClock`, `SeededRandom`; type `Clock`.

There are no Testcontainers or Supertest helpers in `testing-kit`. The
database harness belongs to each package that needs one (section 3), and the
HTTP helpers live in `tests/integration/helpers/`.

**Adding a name:** export it explicitly from `index.ts` (never `export *` a
folder, which would publish every future helper by accident), document it on
this page or in a guide under `docs/guides/testing/`, and add it to the list
above. The curated list is the same boundary every context package keeps
([Domain modeling](../domain-modeling.md), Issue 038).

## 8. Before you push

```sh
pnpm lint
pnpm typecheck
pnpm test
```

A test that passes and fails without a code change is a flaky test, and it
gets quarantined with an expiry date rather than retried until it's green:
see [Flaky tests](../testing/flaky-tests.md). Coverage is a ratcheting floor,
not a target: see [Coverage](../testing/coverage.md).

## Further reading

- [Unit test conventions](../testing/unit-test-conventions.md) (Issues 401,
  402, 403, 419): naming, fixtures, fakes, builders.
- [Contract tests for ports](../testing/contract-tests.md) (Issue 409).
- [End-to-end suite](../testing/e2e-suite.md) (Issue 414).
- [Flaky tests](../testing/flaky-tests.md) and [Coverage](../testing/coverage.md).
- [Testing](../testing.md): commands, and the HTTP integration harness.
- TODO(link): performance budget (Issue 415) and snapshot testing (Issue
  418), once merged.
