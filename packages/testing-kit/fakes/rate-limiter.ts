import type { RateLimiter, RateLimitKey, RateLimitResult } from "@verixa/shared-kernel";

import type { ResettableFake } from "./fake-contract.js";

/**
 * Standardized in-memory rate limiter adapter satisfying the `RateLimiter` port.
 * Complies with the `InMemory<Port>` naming convention.
 *
 * Can run in pass-through mode (default, behaving like `NoopRateLimiter`) or in
 * count-tracking mode to test rate limit exhaustion deterministically.
 */
export class InMemoryRateLimiter implements RateLimiter, ResettableFake {
  private readonly counts = new Map<string, number>();
  private maxAllowed: number;

  constructor(maxAllowed: number = 1000) {
    this.maxAllowed = maxAllowed;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async check(key: RateLimitKey): Promise<RateLimitResult> {
    const serialized = `${key.namespace ?? ""}:${key.action}:${key.identifier}`;
    const current = (this.counts.get(serialized) ?? 0) + 1;
    this.counts.set(serialized, current);

    const allowed = current <= this.maxAllowed;
    return {
      allowed,
      remaining: Math.max(0, this.maxAllowed - current),
      resetAt: Date.now() + 60_000,
      limit: this.maxAllowed,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recordFailure(key: RateLimitKey): Promise<void> {
    const serialized = `${key.namespace ?? ""}:${key.action}:${key.identifier}`;
    const current = (this.counts.get(serialized) ?? 0) + 1;
    this.counts.set(serialized, current);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async reset(key?: RateLimitKey): Promise<void> {
    if (key) {
      const serialized = `${key.namespace ?? ""}:${key.action}:${key.identifier}`;
      this.counts.delete(serialized);
    } else {
      this.counts.clear();
    }
  }

  clear(): void {
    this.counts.clear();
  }

  setMaxAllowed(max: number): void {
    this.maxAllowed = max;
  }

  getCallCount(key: RateLimitKey): number {
    const serialized = `${key.namespace ?? ""}:${key.action}:${key.identifier}`;
    return this.counts.get(serialized) ?? 0;
  }
}
