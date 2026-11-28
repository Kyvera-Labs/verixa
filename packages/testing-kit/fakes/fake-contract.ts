/**
 * Requirements for every fake adapter in the testing kit:
 *
 * 1. Named `InMemory<Port>`, for example `InMemoryUserRepository`.
 * 2. Deterministic: no real network, disk or unseeded randomness.
 * 3. Stateful within a test: writes are immediately visible to later reads on the same instance.
 * 4. Resettable: isolated state per instance, cleared with `reset()` or `clear()` or by re-creating
 *    it in `beforeEach`.
 */
export interface ResettableFake {
  /** Resets internal in-memory state back to empty. */
  reset?(): void | Promise<void>;
  clear?(): void;
}
