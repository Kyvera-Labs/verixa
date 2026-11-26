# Snapshot testing for API responses

Vitest can record a value the first time a test runs (a _snapshot_) and fail
every later run where the value differs. In this repo that is used for one
narrow job: catching **accidental drift in the shape of an API response**, such
as a field being renamed, an envelope being restructured or a property going
missing. It is not a general replacement for assertions.

The worked example is
[`tests/integration/error-envelope.spec.ts`](../../../tests/integration/error-envelope.spec.ts),
which snapshots the shared error envelope (`ErrorResponseBody` in
`apps/api/src/http/error-response.ts`) over real HTTP for a 400, 401, 403 and 500. Its recorded output is
[`tests/integration/__snapshots__/error-envelope.spec.ts.snap`](../../../tests/integration/__snapshots__/error-envelope.spec.ts.snap).

## Why snapshots are useful, and how they go wrong

A snapshot is the cheapest possible test of "this structure did not change".
Writing it costs one line, and it covers every field, including the ones
nobody thought to assert on. That's why it suits response shapes: the
failure we worry about is the field nobody was looking at.

They also go wrong in a well-known way. A snapshot fails, someone runs
`vitest -u`, the new output is committed, and the reviewer approves a
40-line `.snap` diff without reading it. After that the test still passes and
still looks like coverage, but it's a rubber stamp. Everything below exists
to keep snapshots from ending up there.

## When to snapshot

Snapshot a value when **all** of these hold:

- **It is a contract shape.** Clients depend on its structure. Error
  envelopes, pagination wrappers (`items` / `nextCursor` / `hasMore`), and
  success bodies documented in `apps/api/openapi/openapi.yaml` are the
  intended targets.
- **It is stable.** A change to it is rare, and a change is a decision someone
  should notice: a breaking change to an API, or at least a reviewable one.
- **It is small.** It fits on a screen, so a diff can be read in full.
- **It is deterministic once volatile fields are matched** (see below).

## When not to snapshot

- **Values that legitimately change often.** Generated ids, timestamps,
  counts that depend on seed data, ordering that isn't guaranteed. If most
  of the snapshot would be matchers, assert the fields directly instead.
- **Business rules.** "A suspended user can't log in" is a behaviour. Write
  an assertion that names it. A snapshot that happens to contain the 401
  says nothing about _why_ it's a 401, and the next `-u` would accept a 200
  just as readily.
- **The values a client branches on.** HTTP status and `error.code` are
  asserted explicitly in the example even though the snapshot also contains
  them. Changing them is the kind of change a skimmed snapshot diff lets
  through, so they get an assertion that fails loudly on its own.
- **Security properties.** The 500 case asserts explicitly that the thrown
  error's text never reaches the body. A reviewer reading a snapshot diff
  must not be the only control between a connection string and a client.
- **Large blobs.** Full OpenAPI documents, HTML pages, long lists. Nobody
  reads a 500-line diff, so it gets approved without being read. Snapshot
  the small structural part, or use a schema check (the contract tests in
  `apps/api/tests/contract/` already do this for OpenAPI conformance).

## Handling volatile fields

Never hand-edit a `.snap` file to paper over a changing value, and never let
a per-run value be recorded in one. Make it deterministic at the call site
instead:

- **Property matchers (preferred).** Pass an object of asymmetric matchers to
  `toMatchSnapshot`. The snapshot then records the field's _type_, so it still
  fails if the field is renamed or removed:

  ```ts
  const volatileFields = { error: { requestId: expect.any(String) } };
  expect(body).toMatchSnapshot(volatileFields);
  // .snap: "requestId": Any<String>,
  ```

- **A small named normaliser** when a matcher can't express it, for example
  replacing ids inside a nested array. Give it a name that says what it
  removes (`withoutGeneratedIds`), keep it next to the test, and don't
  normalise anything a reviewer would want to see change.

Deterministic values that are _allowed_ to change, such as human-readable
`message` text or Ajv's validation wording in `details.fields`, stay in the
snapshot. The envelope documents `message` as rewordable, so a change to it
is never a break. But it is visible output, and reviewing a one-line wording
diff costs little.

## Reviewing a snapshot diff

- **Never run `vitest -u` blindly.** Update snapshots only for the test you
  intended to change, for example
  `pnpm --filter @verixa/integration-tests exec vitest run integration/error-envelope.spec.ts -u`,
  and read the resulting diff before committing it.
- **Every `.snap` change in a PR gets an explanation** in the PR description:
  what changed in the response, and whether clients need to know. The PR
  template has a checklist item for this. A `.snap` diff with no explanation
  is a review blocker, not a formality.
- **A diff you didn't expect is a bug report, not an update.** If a change to
  an unrelated module moved an error shape, that's exactly the drift the
  snapshot exists to catch.
- **Obsolete snapshots** (reported by Vitest when a test is renamed or
  removed) should be deleted in the same PR, so the `.snap` file only
  describes tests that exist.
- **CI doesn't write snapshots.** When `CI` is set, Vitest fails on a
  missing snapshot instead of recording it, so a new snapshot test has to
  arrive with its `.snap` file committed.

## File snapshots, not inline snapshots

The example uses `toMatchSnapshot()` (a separate `.snap` file) instead of
`toMatchInlineSnapshot()` (the value written into the test source).

- **Chosen: file snapshots.** The `.snap` file becomes a single, readable
  record of the public error contract. A change to it shows up in a PR as a
  change to _that file_, apart from test-code changes, so a reviewer (or a
  future CODEOWNERS rule) can tell at a glance that a response shape moved.
- **Rejected: inline snapshots.** They keep the expected value next to the
  assertion, which reads better for one small value. But `-u` rewrites the
  test source itself, so a contract change and a test refactor land in the
  same hunk, and four envelopes inline would bury the four assertions
  that matter under a wall of literal JSON.

Two other alternatives were considered and rejected:

- **Explicit `toEqual` on the whole body.** It's precise, but it duplicates
  the envelope by hand in every test, and someone has to update each copy
  on every intentional change. That's the busywork that makes people stop
  writing the test.
- **Schema validation alone** (validating against `errorResponseSchema`). It
  catches missing required fields and unknown codes. It doesn't catch an
  optional field (`details`) disappearing, or a change in how validation
  failures are keyed. Both are useful. The contract tests do the schema
  side, and the snapshot covers the concrete shape.

## Where the test lives

The roadmap suggested `apps/api/interface/__snapshots__/`, but there's no
`interface/` directory in `apps/api`. Its code is under `src/`. The example
is a real-HTTP test, so it sits with the other Supertest-harness tests in
`tests/integration/` and follows that package's `*.spec.ts` naming. Vitest
generates `__snapshots__/` next to it.

## See also

- [`../testing.md`](../testing.md): where each kind of test lives, and the
  HTTP integration harness the example uses.
- `apps/api/src/http/error-response.ts`: the envelope and why its shape is
  fixed.
