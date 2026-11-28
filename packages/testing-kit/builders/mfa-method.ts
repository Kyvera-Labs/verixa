import type { MfaMethod, MfaMethodType } from "@verixa/mfa";

import { makeMfaMethod, type MfaMethodFactoryOptions } from "../factories/mfa-method.js";

type MfaMethodStep = (method: MfaMethod, now: Date) => MfaMethod;

/**
 * Fluent, immutable builder for `MfaMethod`. Each chained call is a domain transition (`disable()`,
 * `recordFailedAttempt()`, `recordTotpUse()`) that `build()` replays in order, so an impossible
 * history fails with the aggregate's own error. `build()` starts from a fresh factory call each
 * time because `MfaMethod` mutates in place.
 */
export class MfaMethodBuilder {
  private constructor(
    private readonly options: MfaMethodFactoryOptions,
    private readonly steps: readonly MfaMethodStep[],
  ) {}

  /** Entry point: an active TOTP method for a fresh user (the factory default). */
  static create(): MfaMethodBuilder {
    return new MfaMethodBuilder({}, []);
  }

  /** The user this method is enrolled for. */
  forUser(userId: string): MfaMethodBuilder {
    return this.withOptions({ userId });
  }

  /** The factor kind: `totp`, `webauthn`, or `backup_codes`. */
  ofType(type: MfaMethodType): MfaMethodBuilder {
    return this.withOptions({ type });
  }

  /** Enrolled but not yet confirmed — `pending`, still holding its secret. */
  pendingEnrollment(secret?: string): MfaMethodBuilder {
    return this.withOptions({ status: "pending", ...(secret === undefined ? {} : { secret }) });
  }

  /** The owner switched the method off. A disabled method cannot satisfy a challenge. */
  disabled(): MfaMethodBuilder {
    return this.withStep((method, now) => method.disable(now));
  }

  /** `count` consecutive wrong codes; from the fifth onward the method is rate-limited. */
  afterFailedAttempts(count: number): MfaMethodBuilder {
    return this.withStep((method, now) => {
      for (let i = 0; i < count; i += 1) {
        method.recordFailedAttempt(now);
      }
      return method;
    });
  }

  /** A successful verification — clears any lockout. Refused by the domain unless active. */
  recentlyUsed(): MfaMethodBuilder {
    return this.withStep((method, now) => method.recordUse(now));
  }

  /** A TOTP code for time step `step` was accepted, so that step (and earlier) is now a replay. */
  withConsumedTotpStep(step: number): MfaMethodBuilder {
    return this.withStep((method, now) => method.recordTotpUse(step, now));
  }

  /** Builds a fresh, domain-valid `MfaMethod`, replaying the chain through the aggregate. */
  build(now: Date = new Date()): MfaMethod {
    const initial = makeMfaMethod({ ...this.options, now });
    return this.steps.reduce((method, step) => step(method, now), initial);
  }

  private withOptions(options: MfaMethodFactoryOptions): MfaMethodBuilder {
    return new MfaMethodBuilder({ ...this.options, ...options }, this.steps);
  }

  private withStep(step: MfaMethodStep): MfaMethodBuilder {
    return new MfaMethodBuilder(this.options, [...this.steps, step]);
  }
}

/** `anMfaMethod().ofType('totp').afterFailedAttempts(5).build()` */
export function anMfaMethod(): MfaMethodBuilder {
  return MfaMethodBuilder.create();
}
