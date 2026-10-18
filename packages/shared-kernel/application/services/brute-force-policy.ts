import type { BruteForceAttemptStore } from "../ports/brute-force-attempt-store.js";
import type { RateLimiter } from "../ports/rate-limiter.js";

/**
 * The kinds of attempt this policy is allowed to count (Issue 209).
 *
 * A union rather than a free string: an unrecognised scope would silently
 * create its own counter bucket, so a typo would appear to work while
 * protecting nothing. Making it a type error is the only way to catch that
 * without a test for every spelling.
 *
 * `login` and `password-reset` are wired into the credential endpoints today.
 * `mfa` and `api-key` are declared so the key derivation and the tests cover
 * them, and the endpoints that use them can adopt the same instance without a
 * redesign — see `docs/security/brute-force-protection.md` for why the MFA
 * endpoint is not wired yet.
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
 * Refuses repeated guessing against one secret, keyed by who is being
 * impersonated rather than by what they typed.
 *
 * ## What this adds to the per-account lockout
 *
 * `Credential.recordFailedAttempt` already counts failures and locks an
 * account. It cannot help with the two cases that matter most to an attacker:
 *
 * - **An identifier with no account.** A probe against `nobody@example.com`
 *   advances nothing, because there is no row to advance. Mass enumeration of
 *   a stolen user list is therefore completely unthrottled by a per-row
 *   counter.
 * - **A distributed guess.** Password spraying tries one common password
 *   against thousands of accounts, one attempt each — below every per-account
 *   threshold, forever.
 *
 * This policy counts failures per `scope:identifier` in a store of its own, so
 * the first case accumulates and the second is visible at least per target.
 * It is a gate in front of the use case, not a replacement for the aggregate's
 * own counter: the two are additive, and a real lockout still comes from the
 * row that a restart cannot erase.
 *
 * ## Why it composes with a rate limiter instead of wrapping one
 *
 * A limiter counts *requests*; this counts *failures*. They answer different
 * questions, and the dangerous combination is the one where each sees the
 * other as satisfied: a limiter that permits 10 requests a minute and a policy
 * with a threshold of 5 would let a burst through if either gate were checked
 * alone. So `check` requires both to allow, and reports which refused.
 *
 * What that deliberately does not do is multiply penalties. A refused request
 * records no failure, so an attacker already in lockout does not climb the
 * backoff ladder for being told to wait — the counter moves on failures, and
 * the gate is read-only.
 *
 * ## The honest limits
 *
 * In-memory, per process. A restart clears it, a second API replica has its
 * own, and the identifier is only as good as the caller's normalisation. Phase
 * 15 replaces the store with a durable one behind the same port; nothing here
 * changes when that happens.
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
   * The bucket a set of attempts shares.
   *
   * Lowercased and trimmed so `Admin@Example.com ` and `admin@example.com` are
   * one key. This is *not* an attempt at canonicalising an address — the two
   * differ in the local part for some providers, and getting that wrong would
   * merge two people's budgets. It only has to be close enough that the same
   * attacker typing the same string does not get a fresh bucket for each
   * spelling mistake.
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

    const limit = await this.limiter?.check(key);
    const limited = limit !== undefined && !limit.allowed;
    const locked = remainingMs > 0;

    if (!locked && !limited) {
      return { allowed: true };
    }

    const lockoutSeconds = locked ? Math.ceil(remainingMs / 1000) : undefined;
    const limiterSeconds = limited ? limit?.retryAfterSeconds : undefined;
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
