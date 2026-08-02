# Testing

[Vitest](https://vitest.dev/) is the test runner for the whole monorepo.
Every package (`apps/api`, `packages/config`, `packages/shared-kernel`, and
every package added after them) has its own `vitest.config.ts`, which
`mergeConfig`s the shared base at the repo root (`vitest.config.ts`) with
that package's own `test.name` (shown in output to tell packages apart when
tests run concurrently):

```ts
// packages/<name>/vitest.config.ts
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config.js";

export default mergeConfig(baseConfig, defineConfig({ test: { name: "@verixa/<name>" } }));
```

## Commands

```bash
pnpm test              # run every package's tests once (CI mode)
pnpm test:coverage     # same, with a coverage report per package
```

Both delegate to `pnpm -r run test[:coverage]`, so pnpm runs each package's
tests separately, in its own process, with that package's own
`node_modules` and working directory — not one giant test run across the
whole repo. This matters once packages import each other (Issue 007): a
package's tests need to resolve its dependencies exactly the way that
package would at runtime.

Coverage uses the `v8` provider (`@vitest/coverage-v8`) and writes `text`
(terminal), `html`, and `lcov` reports to each package's `coverage/`
directory (git-ignored, regenerated on every `test:coverage` run).

## Unit vs. integration vs. e2e — where each lives here

- **Unit tests** (`*.spec.ts`, colocated next to the file they test, e.g.
  `domain/result.ts` / `domain/result.spec.ts`) test one module in
  isolation — pure functions, a single class, a use case against in-memory
  fakes. These are the vast majority of tests in this repo and should run in
  milliseconds with no I/O.
- **Integration tests** (`tests/integration/`, its own workspace package —
  `@verixa/integration-tests`) exercise a real boundary — an HTTP route
  through Fastify's actual routing/serialization, or (starting Phase 03) a
  repository against a real database via Testcontainers. Slower than unit
  tests, but they catch bugs unit tests structurally can't: wrong content
  type, a validation rule that only fires at the HTTP layer, a SQL query
  that's syntactically fine but wrong.
- **End-to-end tests** (Phase 21) exercise a fully running system — the kind
  of test that would still catch a bug even if every individual unit and
  integration test passed, because it's the only kind that includes _every_
  layer at once (start of an HTTP request from a real client to a real
  response, no test-harness shortcuts). These are the slowest and most
  brittle, so they're reserved for critical user-facing flows, not every
  code path.

The rule of thumb for where a _new_ test belongs: test the smallest thing
that would actually catch the bug you're worried about. A validation rule
belongs in a unit test next to the validator; "does this route return the
right status code for a duplicate email" belongs in an integration test
that goes through real HTTP; "can a user actually register end-to-end" is
the rare case that justifies an e2e test.

## The HTTP integration test harness

`tests/integration/helpers/http-client.ts` boots a real `apps/api` Fastify
instance in-process and hands back a [Supertest](https://github.com/ladjs/supertest)
agent bound to it:

```ts
import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

describe("GET /health", () => {
  let client: HttpTestClient | undefined;

  afterEach(async () => {
    await client?.close(); // always close, even on failure
    client = undefined;
  });

  it("responds with 200 over real HTTP", async () => {
    client = await createHttpTestClient();
    const response = await client.request.get("/health");
    expect(response.status).toBe(200);
  });
});
```

It imports `@verixa/api/app` — a dedicated `exports` subpath
(`apps/api/package.json`) that resolves to just `buildApp()` — rather than
`@verixa/api` itself, which is `server.ts`: that module calls `loadConfig()`
and `app.listen()` as side effects of being imported, which is exactly what
a test harness must not trigger (it wants a fresh, unstarted app instance
per test, not the one real server instance racing to bind a port).

### Why go through real HTTP instead of calling the route handler directly

It would be faster to import `buildApp`'s route handler function and call it
like a plain function. That's tempting, and wrong for integration tests:
calling the handler directly skips everything Fastify does _around_ it —
request parsing, schema validation, serialization of the response back to
JSON, content-type headers, error-handler middleware. A bug in any of those
(a route that returns the right object but forgets to `JSON.stringify`-compatible
types, so serialization silently drops a field) is invisible to a test that
calls the handler function directly, because that layer never ran. Routing
the test through `supertest(app.server)` — real HTTP, over a local socket —
exercises the exact same code path a real client hits.

### Clean teardown

`client.close()` calls Fastify's `app.close()`, which shuts down the
underlying HTTP server and closes it cleanly — the `afterEach` hook always
calls it, including when the test itself fails (`afterEach` still runs), so
a failing assertion never leaks an open server handle into the next test.

## Sample tests as a template, not a target

Every package that exists purely as foundational tooling right now (there
isn't one at the moment — `packages/config` and `packages/shared-kernel`
both already have real tests) would get one trivial passing test just to
prove the runner and config work, to be replaced by real tests as soon as
real code lands. Don't leave a placeholder test behind once a package has
actual coverage — a `expect(true).toBe(true)` test sitting next to real
tests adds noise, not signal.
