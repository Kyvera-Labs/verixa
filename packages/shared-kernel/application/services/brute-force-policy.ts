import type { BruteForceAttemptStore } from "../ports/brute-force-attempt-store.js";
import type { RateLimiter } from "../ports/rate-limiter.js";

/**
 * Attempt kinds the policy may count. A union, not a free string, so a typo cannot silently create
 * an unprotected counter. `login` and `password-reset` are wired to the credential endpoints; `mfa`
 * and `api-key` are declared for later adoption (see docs/security/brute-force-protection.md).
 */
export type BruteForceScope = "login" | "mfa" | "password-reset" | "api-key";

/** How many failures are tolerated, and for how long a key is then refused. */
export interface BruteForceThresholds {
  /** Failures against one key that trigger the first refusal. */
  readonly threshold: number;
  /** How long the first refusal lasts. */
  readonly baseDurationMs: number;
  /** Multiplier applied per failure past the threshold. */
  readonly backoffFactor: number;
  /** Ceiling on a single refusal window. */
  readonly maxDurationMs: number;
}

/**
 * The same numbers as the per-credential lockout policy.
 *
 * Deliberate: two counters guarding one login flow with different thresholds
 * means the effective policy is whichever is looser, and nobody can say what
 * it is without reading both. Aligned values make the pair describable in one
 * sentence.
 */
export const DEFAULT_BRUTE_FORCE_THRESHOLDS: BruteForceThresholds = {
  threshold: 5,
  baseDurationMs: 60_000,
  backoffFactor: 2,
  maxDurationMs: 3_600_000,
};

/**
 * Which gate refused a request.
 *
 * Diagnostic, and kept out of every response body: telling a client that it
 * was refused by an *IP* limiter rather than an account lockout tells it which
 * resource to rotate. It exists for logs and for tests.
 */
export type BruteForceDenialSource = "lockout" | "rate-limit" | "both";

export interface BruteForceDecision {
  readonly allowed: boolean;
  /**
   * Seconds until the request would be admitted, when that is known.
   *
   * Optional rather than `0` because "no idea" and "now" are different
   * answers, and callers that surface one will surface the other.
   */
  readonly retryAfterSeconds?: number;
  readonly source?: BruteForceDenialSource;
}

/**
 * Limits repeated guessing per `scope:identifier`, adding to the per-account lockout on
 * `Credential`. It also covers identifiers with no account (otherwise enumeration of a stolen user
 * list is unthrottled) and makes password spraying visible per target.
 *
 * `check` requires both this policy and the rate limiter to allow: a limiter counts requests, this
 * counts failures. Refused requests record no failure, so being told to wait does not extend a
 * lockout.
 *
 * The in-memory store is per process: a restart clears it and each replica has its own. A durable
 * store can replace it behind the same port.
 */
export class BruteForcePolicy {
  private readonly thresholds: BruteForceThresholds;

  constructor(
    private readonly store: BruteForceAttemptStore,
    /**
     * Partial, filled from the defaults. A deployment that only wants to lower
     * the threshold should not have to restate the backoff curve along with it,
     * since restating it is how a copied default silently stops tracking the
     * per-credential policy it is meant to match.
     */
    thresholds: Partial<BruteForceThresholds> = {},
    private readonly limiter?: RateLimiter,
  ) {
    this.thresholds = { ...DEFAULT_BRUTE_FORCE_THRESHOLDS, ...thresholds };
  }

  /**
   * The bucket a set of attempts shares: scope plus the identifier lowercased and trimmed, so
   * trivial spelling variants of the same input share one bucket. It does not try to canonicalize
   * email addresses.
   */
  static key(scope: BruteForceScope, identifier: string): string {
    return `${scope}:${identifier.trim().toLowerCase()}`;
  }

  /** Whether an attempt on `identifier` may proceed right now. */
  async check(scope: BruteForceScope, identifier: string): Promise<BruteForceDecision> {
    const key = BruteForcePolicy.key(scope, identifier);
    const record = await this.store.read(key);
    const remainingMs = this.remainingLockMs(record.lockedUntil);

    if (remainingMs === 0 && record.lockedUntil !== null) {
      // The window has elapsed. Forgetting the key is what makes the
      // threshold count a *run* of failures rather than a lifetime total;
      // leaving the stale count in place would lock a legitimate user out
      // for a fifth mistype a year later.
      await this.store.clear(key);
    }

    const limit = await this.limiter?.check({
      action: scope,
      identifier: identifier.trim().toLowerCase(),
    });
    const limited = limit !== undefined && !limit.allowed;
    const locked = remainingMs > 0;

    if (!locked && !limited) {
      return { allowed: true };
    }

    const lockoutSeconds = locked ? Math.ceil(remainingMs / 1000) : undefined;
    const limiterSeconds = limited ? secondsUntil(limit.resetAt) : undefined;
    const seconds =
      lockoutSeconds !== undefined && limiterSeconds !== undefined
        ? Math.max(lockoutSeconds, limiterSeconds)
        : (lockoutSeconds ?? limiterSeconds);

    return {
      allowed: false,
      source: locked && limited ? "both" : locked ? "lockout" : "rate-limit",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    };
  }

  /**
   * Records one failed attempt.
   *
   * Called only for the failures that the aggregate's own counter cannot see,
   * so a wrong password on an existing account is not double-counted here —
   * see the wiring in `AuthenticateWithPassword`.
   */
  async recordFailure(scope: BruteForceScope, identifier: string): Promise<void> {
    const key = BruteForcePolicy.key(scope, identifier);
    const { failedAttempts } = await this.store.read(key);

    // The duration depends on the count *after* this failure, which is known
    // before the write because the store increments by exactly one. A durable
    // adapter should make read-then-write atomic; the in-memory one cannot be
    // interleaved with itself, so today the gap is not exploitable.
    await this.store.recordFailure(key, this.lockUntil(failedAttempts + 1));
  }

  /** Forgets the key. Called on success, so the threshold counts consecutive failures. */
  async recordSuccess(scope: BruteForceScope, identifier: string): Promise<void> {
    await this.store.clear(BruteForcePolicy.key(scope, identifier));
  }

  private remainingLockMs(lockedUntil: Date | null): number {
    if (lockedUntil === null) return 0;
    return Math.max(lockedUntil.getTime() - Date.now(), 0);
  }

  private lockUntil(failedAttempts: number): Date | null {
    const durationMs = lockDurationMs(failedAttempts, this.thresholds);
    if (durationMs === 0) return null;
    return new Date(Date.now() + durationMs);
  }
}

/** A reset time that is not in the future tells the caller nothing about when to retry. */
function secondsUntil(resetAt: number): number | undefined {
  const remainingMs = resetAt - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : undefined;
}

/**
 * How long to refuse after `failedAttempts` failures against one key.
 *
 * Mirrors the per-credential lockout arithmetic on purpose (the two counters
 * are meant to agree), and is duplicated rather than shared because
 * `shared-kernel` must not depend on a domain package. If the two ever drift,
 * the effective policy becomes the looser one, silently — so the numbers above
 * are the place to change, not this function.
 */
function lockDurationMs(failedAttempts: number, thresholds: BruteForceThresholds): number {
  if (failedAttempts < thresholds.threshold) return 0;

  const stepsPastThreshold = failedAttempts - thresholds.threshold;
  // Capped before the multiplication: a counter that keeps climbing makes
  // `base * factor ** steps` overflow to Infinity, and `new Date(Infinity)` is
  // an Invalid Date, which the store would persist as "never locked".
  const uncapped =
    stepsPastThreshold > 64
      ? thresholds.maxDurationMs
      : thresholds.baseDurationMs * thresholds.backoffFactor ** stepsPastThreshold;

  return Math.min(uncapped, thresholds.maxDurationMs);
}
