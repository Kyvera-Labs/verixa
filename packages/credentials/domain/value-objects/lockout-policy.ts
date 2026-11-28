/**
 * How many consecutive failures are tolerated, and how long a lock lasts.
 *
 * Separated from `Credential` so the thresholds are configuration rather than
 * a rule baked into the aggregate — a deployment facing credential stuffing
 * can tighten them without a code change, and the tests can use values that
 * do not make the suite sleep.
 */
export interface LockoutPolicy {
  /** Consecutive failures that trigger the first lock. */
  readonly threshold: number;
  /** How long the first lock lasts. */
  readonly baseDurationMs: number;
  /**
   * Multiplier applied per failure past the threshold. Exponential backoff makes a sustained
   * guessing campaign impractical, while a fixed window would still allow hundreds of guesses a
   * day.
   */
  readonly backoffFactor: number;
  /**
   * Ceiling on a single lock.
   *
   * Exponential growth without a cap is a denial-of-service handed to
   * attackers: anyone who knows an address can lock its owner out for years
   * by failing enough times. The cap is what keeps lockout a speed bump for
   * the attacker rather than a weapon against the user. Account recovery
   * is the escape hatch that makes even the cap survivable.
   */
  readonly maxDurationMs: number;
}

/**
 * Defaults, roughly aligned with OWASP's guidance on lockout windows.
 *
 * Five attempts is forgiving enough that ordinary mistyping does not trip it,
 * and the first lock is deliberately short — long enough to destroy the
 * economics of online guessing, short enough that a legitimate user who walks
 * away and comes back finds it cleared.
 */
export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  baseDurationMs: 60_000,
  backoffFactor: 2,
  maxDurationMs: 3_600_000,
};

/**
 * How long a lock should last after `failedAttempts` consecutive failures.
 *
 * Returns 0 below the threshold. At and above it, the duration doubles per
 * extra failure, capped at `maxDurationMs`.
 */
export function lockDurationMs(failedAttempts: number, policy: LockoutPolicy): number {
  if (failedAttempts < policy.threshold) {
    return 0;
  }

  const stepsPastThreshold = failedAttempts - policy.threshold;
  // `Number.MAX_SAFE_INTEGER` is reachable here: a counter that keeps rising
  // makes this overflow to Infinity, and `new Date(Infinity)` is an Invalid
  // Date, which would be written to the database as null and silently unlock
  // the account. Capping before the multiplication rather than after is what
  // avoids that.
  const uncapped =
    stepsPastThreshold > 64
      ? policy.maxDurationMs
      : policy.baseDurationMs * policy.backoffFactor ** stepsPastThreshold;

  return Math.min(uncapped, policy.maxDurationMs);
}
