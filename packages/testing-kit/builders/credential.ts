import { type Credential, DEFAULT_LOCKOUT_POLICY, type LockoutPolicy } from "@verixa/credentials";

import { makeCredential, type CredentialFactoryOptions } from "../factories/credential.js";

type CredentialStep = (credential: Credential, now: Date) => Credential;

/**
 * `PasswordHistoryPolicy` is not part of `@verixa/credentials`' public API (nor
 * is its default), so the type is read off the entity method that consumes it
 * rather than deep-imported past the package boundary.
 */
type PasswordHistoryPolicy = Parameters<Credential["rotatePassword"]>[1];

/**
 * Fluent, immutable builder for the `Credential` entity (Issue 419).
 *
 * Starts from {@link makeCredential} (`Credential.create`) and reaches lockout,
 * password history and deletion through the entity's own operations —
 * `recordFailedAttempt(policy)`, `rotatePassword(hash, policy)`,
 * `invalidateForDeletedUser()` — instead of the factory's raw
 * `failedAttempts` / `lockedUntil` overrides. A lock produced this way has
 * exactly the duration `LockoutPolicy` would compute, so a test asserting on
 * "locked for one minute" is asserting on the real backoff, not a number typed
 * into a fixture.
 *
 * Unlike the other aggregates, `Credential` has no refusable transitions (every
 * operation is total), so no chain can fail at `build()`.
 */
export class CredentialBuilder {
  private constructor(
    private readonly options: CredentialFactoryOptions,
    private readonly steps: readonly CredentialStep[],
  ) {}

  /** Entry point: a fresh password credential, no failures, no history. */
  static create(): CredentialBuilder {
    return new CredentialBuilder({}, []);
  }

  /** The user this credential authenticates. */
  forUser(userId: string): CredentialBuilder {
    return this.withOptions({ userId });
  }

  /** The current password hash (as produced by the password hasher port). */
  withPasswordHash(passwordHash: string): CredentialBuilder {
    return this.withOptions({ passwordHash });
  }

  /** `count` consecutive failed logins under `policy`; at the threshold the credential locks. */
  afterFailedLogins(
    count: number,
    policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
  ): CredentialBuilder {
    return this.withStep((credential, now) => {
      let next = credential;
      for (let i = 0; i < count; i += 1) {
        next = next.recordFailedAttempt(policy, now);
      }
      return next;
    });
  }

  /** Exactly enough failed logins to trip `policy`'s first lockout. */
  lockedOut(policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY): CredentialBuilder {
    return this.afterFailedLogins(policy.threshold, policy);
  }

  /**
   * The owner changed their password to each hash in turn; previous hashes
   * enter history, capped at `policy.depth`. The policy is required: a test
   * about history is a test about its depth, so it should say which one.
   */
  afterPasswordRotations(
    policy: PasswordHistoryPolicy,
    ...newPasswordHashes: readonly string[]
  ): CredentialBuilder {
    return this.withStep((credential) =>
      newPasswordHashes.reduce((next, hash) => next.rotatePassword(hash, policy), credential),
    );
  }

  /** The owning user was deleted, so the hash was replaced by an unverifiable sentinel. */
  forDeletedUser(): CredentialBuilder {
    return this.withStep((credential, now) => credential.invalidateForDeletedUser(now));
  }

  /** Builds a fresh, domain-valid `Credential` by replaying the chain through the entity. */
  build(now: Date = new Date()): Credential {
    const initial = makeCredential(this.options);
    return this.steps.reduce((credential, step) => step(credential, now), initial);
  }

  private withOptions(options: CredentialFactoryOptions): CredentialBuilder {
    return new CredentialBuilder({ ...this.options, ...options }, this.steps);
  }

  private withStep(step: CredentialStep): CredentialBuilder {
    return new CredentialBuilder(this.options, [...this.steps, step]);
  }
}

/** `aCredential().lockedOut().build()` */
export function aCredential(): CredentialBuilder {
  return CredentialBuilder.create();
}
