/**
 * Decides how long audit entries are kept before they become candidates for archival or erasure.
 *
 * This port only nominates candidates; it never deletes. Erasure is a legal decision and conflicts
 * with append-only tamper evidence, so it will arrive as a separate reviewed operation, expected to
 * remove content while keeping an anchored digest and appending an explicit erasure entry.
 */
export interface RetentionPolicy {
  /** Identifies the policy in a review's output. Name it as a rule, not a number: `eu-account-activity-7y`. */
  readonly name: string;

  /**
   * Returns the instant at or before which an entry is past retention. `now` is a parameter so
   * tests can pin the boundary. A policy that must nominate nothing, such as a legal hold, returns
   * the earliest possible date.
   */
  cutoffDate(now: Date): Date;
}

/** One year of milliseconds, and the same ambiguity that makes `365` worth stating. */
const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;

/** A retention window expressed in whole days. */
export interface RetentionWindow {
  readonly days: number;
}

/**
 * The one policy shape this phase needs: keep entries for N days.
 *
 * A class rather than a bare function because the *identity* of the policy has
 * to travel with its decision. A review that reports "records older than
 * 2024-03-01 are candidates" without saying which rule produced that date is
 * not actionable — the operator cannot tell whether the seven-year financial
 * rule or the ninety-day support-log rule was applied.
 */
export class AgeRetentionPolicy implements RetentionPolicy {
  readonly name: string;
  readonly window: RetentionWindow;

  constructor(name: string, window: RetentionWindow) {
    if (!Number.isInteger(window.days) || window.days < 1) {
      throw new Error(`Retention window for "${name}" must be a whole number of days >= 1.`);
    }

    this.name = name;
    this.window = window;
  }

  /** A window of `years` calendar years, rounded to whole days. */
  static yearly(name: string, years: number): AgeRetentionPolicy {
    return new AgeRetentionPolicy(name, { days: years * DAYS_PER_YEAR });
  }

  cutoffDate(now: Date): Date {
    return new Date(now.getTime() - this.window.days * MS_PER_DAY);
  }
}

/**
 * The default window for a deployment with no policy configured: seven years.
 *
 * Not a safe default so much as a *conservative* one — it is the length common
 * to financial-record obligations, and erring the other way (short) destroys
 * evidence an operator may still be legally required to hold. The correct value
 * is always the deployment's, and configuring it is an operator task.
 */
export const DEFAULT_RETENTION_WINDOW_DAYS = 7 * DAYS_PER_YEAR;

/** The policy used when a caller supplies none. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = new AgeRetentionPolicy("default-7y", {
  days: DEFAULT_RETENTION_WINDOW_DAYS,
});
