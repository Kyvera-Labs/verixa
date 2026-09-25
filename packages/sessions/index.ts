/**
 * @verixa/sessions – Session lifecycle, JWT token issuance, revocation, and
 * session-based authentication primitives for Phase 05 and later.
 *
 * This package encapsulates sessions as a bounded context: domain entities
 * (`Session`, `RefreshToken`, `SessionExpiryPolicy`), application ports
 * (`SessionRepository`), and infrastructure implementations (Prisma persistence,
 * in-memory testing).
 *
 * ### Public API Surface
 *
 * Only the items listed below are meant to be consumed outside this package.
 * Internal implementation (mappers, error handlers, testing harnesses) is not
 * exported; deep imports via `@verixa/sessions/infrastructure/...` are
 * prevented by the eslint `no-restricted-imports` rule.
 *
 * **Domain layer:**
 * - `Session` aggregate with `create`, `reconstitute`, `touch`, `revoke` methods
 * - `RefreshToken` entity with opaque, hashed bearer token design (Issue 086)
 * - `SessionExpiryPolicy` value object with `sliding` and `absolute` modes
 * - `SessionStatus` type for lifecycle states
 *
 * **Application layer:**
 * - `SessionRepository` port defining behavioral contract for persistence
 *
 * **Infrastructure (for use-case wiring):**
 * - `PrismaSessionRepository` for Postgres-backed persistence
 * - `InMemorySessionRepository` for testing and component composition
 *
 * See `docs/guides/domain-modeling.md` for the domain modeling rationale and
 * architectural decisions specific to sessions.
 */

// Domain
export { Session, type SessionId, type SessionStatus, type UserId } from "./domain/entities/session.js";
export { RefreshToken, type RefreshTokenId, type IssuedRefreshToken } from "./domain/entities/refresh-token.js";
export {
  SessionExpiryPolicy,
  type SessionExpiryMode,
} from "./domain/value-objects/session-expiry-policy.js";

// Application
export type { SessionRepository } from "./application/ports/session-repository.js";

// Infrastructure — adapters only
export { PrismaSessionRepository } from "./infrastructure/persistence/prisma-session-repository.js";
export { InMemorySessionRepository } from "./infrastructure/testing/in-memory-session-repository.js";
