/**
 * Written checklist and contract for compliant test doubles in Verixa.
 *
 * ## Compliant Fake Adapter Checklist
 *
 * Any fake adapter registered or created in `testing-kit` must satisfy four requirements:
 *
 * 1. **Naming Convention (`InMemory<Port>`)**:
 *    Every fake implementing a port named `<Port>` must be named `InMemory<Port>`
 *    (e.g., `UserRepository` -> `InMemoryUserRepository`, `RateLimiter` -> `InMemoryRateLimiter`).
 *
 * 2. **Deterministic**:
 *    Must not perform real external I/O (no live network, disk, or unseeded random generation).
 *    All operations execute synchronously or return immediately resolved/rejected promises.
 *
 * 3. **Stateful Within a Test**:
 *    Mutations through methods like `save()`, `delete()`, or `record()` must immediately be
 *    observable in subsequent queries (`findById()`, `findMany()`, `exists()`) within that instance.
 *
 * 4. **Resettable Between Tests**:
 *    Each fake instance must provide an isolated state store (e.g., in-memory `Map` or `Set`),
 *    and allow clearing via an explicit `reset()` / `clear()` method or clean re-instantiation
 *    in `beforeEach()` hooks so no state leaks across test boundaries.
 */
export interface ResettableFake {
  /** Resets internal in-memory state back to empty. */
  reset?(): void | Promise<void>;
  clear?(): void;
}
