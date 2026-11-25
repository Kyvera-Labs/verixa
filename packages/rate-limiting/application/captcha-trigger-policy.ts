/**
 * Subject evaluated by CaptchaTriggerPolicy.
 */
export interface CaptchaSubject {
  /** Account email, username, or subject identifier */
  readonly identifier?: string | undefined;
  /** Client IP address */
  readonly ip?: string | undefined;
  /** Action being protected (e.g. 'login', 'register', 'password-reset') */
  readonly action?: string | undefined;
}

/**
 * Configuration options for CaptchaTriggerPolicy.
 */
export interface CaptchaTriggerPolicyOptions {
  /**
   * Number of consecutive failed attempts before a CAPTCHA challenge is triggered.
   * Default is 3 (acting as an intermediate friction layer before hard account lockout at 5).
   */
  readonly failureThreshold?: number | undefined;
  /**
   * Time window in milliseconds for tracking failures.
   * Default is 15 minutes (900_000 ms).
   */
  readonly windowMs?: number | undefined;
}

interface FailureEntry {
  count: number;
  expiresAt: number;
}

/**
 * CaptchaTriggerPolicy
 *
 * Decides when an abuse-sensitive endpoint requires a human-verification challenge (CAPTCHA).
 * Rather than subjecting all legitimate users to CAPTCHA friction on every request,
 * the policy serves as an adaptive friction layer triggered after N consecutive failures
 * from either the targeting account or the originating client IP.
 */
export class CaptchaTriggerPolicy {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly failures = new Map<string, FailureEntry>();

  constructor(options: CaptchaTriggerPolicyOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.windowMs = Math.max(1000, options.windowMs ?? 15 * 60 * 1000);
  }

  /**
   * Checks whether a CAPTCHA challenge is required for the given subject.
   * Returns true if either the account identifier OR the client IP has met or exceeded the failure threshold.
   */
  isChallengeRequired(subject: CaptchaSubject | string, now: number = Date.now()): boolean {
    const keys = this.deriveKeys(subject);
    for (const key of keys) {
      this.evictIfExpired(key, now);
      const entry = this.failures.get(key);
      if (entry && entry.count >= this.failureThreshold) {
        return true;
      }
    }
    return false;
  }

  /**
   * Records a failed attempt for the subject, incrementing failure counters across both account and IP dimensions.
   */
  recordFailure(subject: CaptchaSubject | string, now: number = Date.now()): void {
    const keys = this.deriveKeys(subject);
    for (const key of keys) {
      this.evictIfExpired(key, now);
      const existing = this.failures.get(key);
      if (!existing || now >= existing.expiresAt) {
        this.failures.set(key, {
          count: 1,
          expiresAt: now + this.windowMs,
        });
      } else {
        existing.count += 1;
        existing.expiresAt = now + this.windowMs;
      }
    }
  }

  /**
   * Resets failure counters upon a successful operation (e.g. successful login).
   */
  recordSuccess(subject: CaptchaSubject | string): void {
    const keys = this.deriveKeys(subject);
    for (const key of keys) {
      this.failures.delete(key);
    }
  }

  /**
   * Returns the highest failure count observed for the subject across its tracking dimensions.
   */
  getFailureCount(subject: CaptchaSubject | string, now: number = Date.now()): number {
    const keys = this.deriveKeys(subject);
    let max = 0;
    for (const key of keys) {
      this.evictIfExpired(key, now);
      const entry = this.failures.get(key);
      if (entry && entry.count > max) {
        max = entry.count;
      }
    }
    return max;
  }

  private deriveKeys(subject: CaptchaSubject | string): string[] {
    if (typeof subject === "string") {
      const trimmed = subject.trim();
      return trimmed.length > 0 ? [`id:${trimmed.toLowerCase()}`] : [];
    }

    const keys: string[] = [];
    const action = subject.action ? `${subject.action}:` : "";

    if (subject.identifier && subject.identifier.trim().length > 0) {
      keys.push(`${action}id:${subject.identifier.trim().toLowerCase()}`);
    }

    if (subject.ip && subject.ip.trim().length > 0) {
      keys.push(`${action}ip:${subject.ip.trim()}`);
    }

    return keys;
  }

  private evictIfExpired(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (entry && now >= entry.expiresAt) {
      this.failures.delete(key);
    }
  }
}
