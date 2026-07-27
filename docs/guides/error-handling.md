# Error Handling: `Result<T, E>`

Every use case in Verixa returns a `Result<T, E>` for **expected** failures
instead of throwing. `Result` lives in `@verixa/shared-kernel`
(`packages/shared-kernel/domain/result.ts`).

## Exceptions vs. explicit result types

Exceptions are invisible in a function's type signature — nothing tells a
caller of `registerUser()` that it might fail because the email is already
taken, short of reading its implementation (or every function it calls,
transitively). That failure mode is _expected_: it happens in normal
operation and the caller is supposed to handle it.

`Result<T, E>` puts that failure back in the signature:

```ts
function registerUser(
  input: RegisterUserInput,
): Result<User, DuplicateEmailError | ValidationError>;
```

Now the compiler forces the caller to deal with both outcomes — there's no
way to "forget" to catch a specific error, because there's nothing to catch.
`match` requires both branches:

```ts
const outcome = registerUser(input);

Result.match(outcome, {
  ok: (user) => reply.status(201).send(user),
  err: (error) => reply.status(error.httpStatusHint).send({ code: error.code }),
});
```

## When to still throw

`Result` is for failures that are part of a use case's normal contract —
validation failures, conflicts, not-found. It is **not** a replacement for
exceptions everywhere:

- **Programmer errors** (a required dependency wasn't injected, an invariant
  the type system should have prevented was violated anyway) should still
  throw. A `Result` implies "the caller should have a plan for this"; a
  broken invariant means the caller's assumptions were already wrong, and
  continuing to run code is more dangerous than crashing loudly.
- **Truly exceptional, unrecoverable conditions** (out of memory, the process
  is shutting down) are also exceptions — there's no meaningful `err` branch
  for a caller to handle.
- **Infrastructure failures the caller can't reasonably recover from inline**
  (e.g. the database connection itself is down, not just "this specific
  query violated a constraint") are usually left to propagate and get caught
  at a top-level error boundary, not threaded through every `Result` in the
  call chain.

The rule of thumb: if you'd write a paragraph in the API docs explaining
"this can fail if...", it's a `Result`. If it would only ever happen because
of a bug, it's a thrown error.

## API

```ts
Result.ok(value); // Result<T, never>
Result.err(error); // Result<never, E>
Result.isOk(result); // type guard
Result.isErr(result); // type guard
Result.map(result, fn); // transform the Ok value, Err passes through
Result.flatMap(result, fn); // chain a step that itself returns a Result
Result.match(result, { ok, err }); // exhaustively unwrap into one value
```

`map` and `flatMap` both short-circuit on `Err` — once a chain of use-case
steps hits a failure, later steps are simply skipped rather than needing
their own guard clauses:

```ts
const result = Result.flatMap(
  Result.flatMap(parseEmail(input.email), (email) => checkNotTaken(email)),
  (email) => createUser(email),
);
```
