# Use Cases (Application Layer)

`RegisterUser` (`packages/identity/application/use-cases/register-user.ts`,
Issue 030) is the first concrete example of the **command-handler pattern**
every use case in Verixa follows: one class, one job, orchestrating domain
objects and ports without containing business rules of its own.

## The shape

```ts
export interface RegisterUserCommand {
  readonly email: string;
  readonly displayName: string;
  readonly givenName?: string;
  readonly familyName?: string;
}

export type RegisterUserError = ValidationError | ConflictError;

export class RegisterUser {
  constructor(private readonly userRepository: UserRepository) {}

  async execute(command: RegisterUserCommand): Promise<Result<User, RegisterUserError>> {
    // 1. Parse/validate primitive input into value objects
    // 2. Check any cross-aggregate invariant the entity itself can't check alone
    //    (e.g. email uniqueness — a single User can't know about other Users)
    // 3. Construct/mutate the aggregate (which enforces its own invariants)
    // 4. Persist via the port
    // 5. Return the result
  }
}
```

Every use case:

- Is a class with **one public method**, conventionally named `execute`,
  taking a single **command** object (a plain data shape, `RegisterUserCommand`
  here) rather than positional parameters — adding a field later doesn't
  break every call site.
- Takes its dependencies (repositories, other ports) as **constructor
  parameters**, typed as the port interface, never a concrete adapter. This
  is what makes it testable without a database: pass an in-memory fake that
  satisfies the same interface (see `docs/guides/testing.md`).
- Returns `Result<T, E>` rather than throwing for expected failure modes
  (validation failure, a conflicting duplicate) — the same convention used
  throughout the domain layer, for the same reason: callers are forced to
  handle failure, and the type signature documents what can go wrong.

## Why use cases are the unit of application logic

A use case is deliberately the _only_ place that orchestrates multiple
steps against ports and aggregates for a single business operation. The
alternative — putting that orchestration in an HTTP route handler, or
spreading it across multiple entity methods — makes the same operation hard
to test without spinning up the interface layer, and hard to reuse if a
second interface (a CLI, a background job) needs to trigger the same
operation later. `RegisterUser.execute()` can be called identically from an
HTTP handler, a CLI command, or a test, with zero HTTP/CLI-specific code
inside it.

Business _rules_ still live in the domain layer, not here: `RegisterUser`
doesn't decide what makes an email valid (`Email.create` does) or what
status a new user starts in (`User.register` does). The use case's job is
narrower — sequencing calls to the domain and ports correctly — which is
exactly what keeps it a thin, easy-to-read orchestration layer instead of a
second place business rules could drift out of sync.

## Validate-before-write ordering

Note the order inside `RegisterUser.execute()`: every input validation
happens first (email format, display name, optional person name), _then_
the uniqueness check against the repository, _then_ the write. A failing
validation never reaches the repository at all — not even a read. This
isn't just tidiness: it means a caller retrying after a validation error
can trust that nothing was persisted, and it avoids spending a database
round-trip on input that was never going to succeed regardless of what the
repository would have said.

## What's deliberately not here yet

`RegisterUser` does not publish the `UserRegistered` event the created
`User` is carrying (`user.pullDomainEvents()`) — it returns the `User`
as-is, events attached. Wiring actual event publishing (via
`DomainEventPublisher`, once an implementation exists — see
`docs/guides/domain-events.md`) is deferred to whichever future issue
introduces the first publisher adapter and an interface-layer caller that's
responsible for the pull-then-publish step after a successful use case
call.
