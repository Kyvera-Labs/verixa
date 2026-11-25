# End-to-end suite

The unit and integration suites call application objects in the same process.
That is fast and useful, but it cannot catch failures in environment parsing,
process startup, listener binding, or the real HTTP boundary. `tests/e2e/`
starts the compiled API as a child process and sends requests over HTTP while
disposable Postgres and Redis containers provide the same services a
deployment expects.

Run the suite after building the workspace:

```bash
pnpm build
pnpm --filter @verixa/integration-tests run test:e2e
```

Docker must be available. The harness applies the checked-in database
migrations to its fresh PostgreSQL instance before starting the server, waits
for `/health`, and always stops the process and containers after the suite.
It does not reuse a developer's compose database: disposable state makes the
suite repeatable and prevents a test from damaging local data.

The first test is deliberately a small health and version round trip. It
proves that the server really started and that requests crossed the network;
it is the prerequisite check for adding broader flows. The test runner excludes
`tests/e2e` from ordinary `pnpm test`, because silently skipping this suite
without Docker would claim integration confidence it did not earn. CI runs it
in a dedicated Docker-enabled job instead.

The alternative — starting Fastify in-process as the integration suite does —
is quicker, but it skips the config and child-process boundary that makes this
suite useful. Keep the E2E set small and reserve business-rule coverage for
faster tests below it in the test pyramid.

---

## Test Data Seeding & Isolation Strategy

E2E test suites often suffer from ordering-dependent flakiness and test pollution when tests rely on shared database state or assume sequential execution order. Verixa enforces strict isolation:

### 1. Per-Test Database Reset (`resetDatabase`)

Implemented in `tests/e2e/harness/reset-database.ts`:

- Deletes records across all tables in reverse foreign-key dependency order (e.g., audit events, role permissions, user role assignments, credentials, verification tokens, organization memberships, users, organizations, roles, permissions).
- Provides `withDatabaseReset(async () => { ... })` to execute any test block inside an isolated lifecycle where cleanup runs reliably in `finally`, even if assertions throw mid-way.

> **Design Decision — Foreign-Key Ordered Deletes vs. Postgres Truncate Cascade / Container Recreation**:
> _Alternative Rejected_: Dropping/recreating schemas or spinning up fresh Docker containers per test file.
> _Reason_: Recreating containers takes seconds per test file, making suites prohibitively slow in local development and CI. Foreign-key ordered deletion completes in single-digit milliseconds per test while achieving the exact same guarantee of an empty schema.

### 2. Deterministic Seeding (`tests/e2e/harness/seed.ts`)

Instead of raw uncontrolled SQL scripts or mutable global fixtures, tests construct deterministic entities using domain factories:

- `seedUser(prisma, overrides)`: Creates verified or unverified users with unique UUIDs.
- `seedCredential(prisma, overrides)`: Hashes passwords with Argon2 and associates credentials with user records.
- `seedOrganization(prisma, overrides)`: Creates organizations with unique slugs and active status.
- `seedRole(prisma, overrides)` and `seedPermission(prisma, overrides)`: Seeds canonical RBAC primitives.
- `seedUserRoleAssignment(prisma, overrides)`: Links users, roles, and organizations with referential integrity.
- `seedCompleteUser(prisma, overrides)`: Helper that seeds a user, credential, and organization membership in a single call.

### 3. Isolation Verification (`tests/e2e/harness/isolation.spec.ts`)

A dedicated meta-test verifies:

- Independent execution ordering (test A followed by B vs. B followed by A produces identical outputs).
- Error-resilient teardown (a failing assertion does not leak uncleaned records to subsequent tests).

---

## Critical Journey Catalogue

### 1. Identity & Authentication Lifecycle

Located at `tests/e2e/journeys/registration-and-login.e2e.test.ts`:

- **Registration**: `POST /auth/register` creates an unverified user and returns `201 Created` with a safe public user representation.
- **Email Verification**: Consumes the verification token via `POST /auth/verify-email`, transitioning the user status to `active`.
- **Login**: `POST /auth/login` verifies credentials with Argon2, returns `200 OK` with access and refresh tokens, and attaches the secure HTTP-only `verixa_session` cookie.
- **Token Refresh**: `POST /auth/refresh` accepts the refresh token (via authorization header, body, or session cookie), issues fresh token pairs, and rotates the session cookie.
- **Logout**: `POST /auth/logout` revokes the server session, invalidates the refresh token, and returns cleared session cookies (`Max-Age=0`).

### 2. Password Reset Lifecycle

Located at `tests/e2e/journeys/password-reset.e2e.test.ts`:

- **Password Reset Request**: `POST /auth/forgot-password` generates a single-use reset token. The endpoint returns `200 OK` with an enumeration-safe message regardless of whether the email exists.
- **Password Reset Execution**: `POST /auth/reset-password` accepts the reset token and new password, updating the password hash and revoking previous tokens.
- **Authentication Verification**:
  - Attempting to log in with the old password yields `401 Unauthorized` (`AUTHENTICATION_FAILED`).
  - Attempting to log in with the new password succeeds with `200 OK` and active session issuance.

### 3. Authorization & RBAC Enforcement

Located at `tests/e2e/journeys/authorization.e2e.test.ts`:

- **Allowed Access**: A user assigned an organization role possessing `resource:read` receives `200 OK` and requested data when accessing `GET /organizations/:orgId/protected-resource`.
- **Denied Access**: A user without the required role or permission receives `403 Forbidden` (`FORBIDDEN_RESOURCE`). The response body is strictly inspected to ensure zero sensitive resource data or stack traces are leaked.
- **Dynamic Role Updates**:
  - Granting a role dynamically updates authorization state immediately without token reissue or server restart.
  - Revoking a role immediately causes subsequent requests to return `403 Forbidden`.
