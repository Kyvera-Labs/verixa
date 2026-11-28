import { Email, type User, type UserStatus } from "@verixa/identity";
import type { MfaEnforcementLevel } from "@verixa/mfa";
import { AccountLockedError, AuthenticationError, Result } from "@verixa/shared-kernel";
import type { BruteForcePolicy, RateLimiter, RateLimitKey } from "@verixa/shared-kernel";

import type { Credential } from "../../domain/entities/credential.js";
import {
  DEFAULT_LOCKOUT_POLICY,
  type LockoutPolicy,
} from "../../domain/value-objects/lockout-policy.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";
import type { PasswordHasher } from "../ports/password-hasher.js";

export interface AuthenticateWithPasswordCommand {
  readonly email: string;
  readonly password: string;
}

export type MfaChallengeResult = {
  readonly status: "mfa_challenge";
  readonly userId: string;
  readonly methods: readonly { readonly id: string; readonly type: string }[];
};

export type EnrollmentRequiredResult = {
  readonly status: "enrollment_required";
  readonly userId: string;
};

export type AuthenticateWithPasswordSuccessResult =
  | { readonly user: User; readonly rehashed: boolean; readonly status?: undefined }
  | MfaChallengeResult
  | EnrollmentRequiredResult;

export interface AuthenticateWithPasswordResult {
  readonly user: User;
  /** True when the stored hash was upgraded during this login. Diagnostic only. */
  readonly rehashed: boolean;
}

export type AuthenticateWithPasswordError = AuthenticationError | AccountLockedError;

export interface MfaChecker {
  resolvePolicy(userId: string): Promise<MfaEnforcementLevel>;
  listActiveMethods(
    userId: string,
  ): Promise<readonly { readonly id: string; readonly type: string }[]>;
}

/**
 * Decoy hashes, one per hasher, verified when there is no real credential so failures cost the same
 * as a real check. Keyed by hasher because a decoy made at different cost parameters would not
 * match its cost. Created lazily in a `WeakMap`, so the first failure in a process is slower.
 */
const decoyHashes = new WeakMap<PasswordHasher, Promise<string>>();

function decoy(hasher: PasswordHasher): Promise<string> {
  let pending = decoyHashes.get(hasher);
  if (pending === undefined) {
    pending = hasher.hash("verixa-timing-decoy");
    decoyHashes.set(hasher, pending);
  }
  return pending;
}

/**
 * What the authentication transaction concluded.
 *
 * A discriminated union rather than `Credential | undefined`, because
 * "locked" and "failed" have to be distinguishable to the caller (they are
 * different operational signals) while being indistinguishable to the client.
 * Collapsing them here would make the second property impossible to state and
 * the first impossible to measure.
 */
type Outcome =
  | { readonly kind: "ok"; readonly user: User; readonly credential: Credential }
  | { readonly kind: "failed" }
  | { readonly kind: "locked" };

/**
 * Account statuses whose owner may still prove who they are.
 *
 * A set rather than a `!== "suspended"` check so adding a status to
 * `UserStatus` fails closed: a new state is not authenticable until someone
 * decides it is. The inverse test would silently admit it.
 */
const CAN_AUTHENTICATE = new Set<UserStatus>(["pending", "active"]);

/**
 * Verifies an email and password, revealing as little as possible on failure.
 *
 * Every failure (no such account, no password credential, wrong password) returns the same error.
 * Distinguishing them would be an account-enumeration oracle (WSTG-IDNT-04).
 *
 * When there is no credential, the password is verified against a decoy hash with the same
 * parameters, so both paths cost one verification. This removes the obvious timing difference; it
 * is not constant time. Lockout and rate limiting handle the rest (see
 * docs/security/authentication-flows.md).
 */
export class AuthenticateWithPassword {
  constructor(
    private readonly unitOfWork: CredentialsUnitOfWork,
    private readonly passwordHasher: PasswordHasher,
    private readonly rateLimiter: RateLimiter,
    private readonly lockoutPolicy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
    private readonly mfaChecker?: MfaChecker,
    /**
     * Optional, and that is the point: a deployment without a shared store
     * still has the per-credential lockout, and every existing caller stays
     * valid. When it is supplied it covers the failures the row-level counter
     * cannot see.
     */
    private readonly bruteForce?: BruteForcePolicy,
  ) {}

  async execute(
    command: AuthenticateWithPasswordCommand,
  ): Promise<Result<AuthenticateWithPasswordSuccessResult, AuthenticateWithPasswordError>> {
    // 1. Check rate limit BEFORE any other logic
    const rateLimitKey: RateLimitKey = {
      action: "login",
      identifier: command.email,
    };

    const limitResult = await this.rateLimiter.check(rateLimitKey);
    if (!limitResult.allowed) {
      throw new Error(
        `Rate limit exceeded for ${rateLimitKey.action} on ${rateLimitKey.identifier}. ` +
          `Resets at ${new Date(limitResult.resetAt).toISOString()}`,
      );
    }

    // Before the email is parsed or any row is read. The attempts this gate
    // exists to throttle are the ones that never reach a credential, so a
    // check after the lookup would spend exactly the read the throttle is
    // meant to save.
    //
    // A refusal is reported as an ordinary failed login, and still burns the
    // decoy hash. The response is therefore indistinguishable from any other
    // failure — which is what keeps this gate from becoming the enumeration
    // oracle the rest of this use case works to remove.
    if (this.bruteForce !== undefined) {
      const gate = await this.bruteForce.check("login", command.email);
      if (!gate.allowed) {
        await this.burnTime(command.password);
        return Result.err(new AuthenticationError());
      }
    }

    // A malformed address is not a validation error here, unlike everywhere
    // else in the codebase. `Email.create` rejecting "not-an-email" is a
    // perfectly good 400 during registration; on a login endpoint it tells an
    // attacker their input never reached the credential lookup, which is one
    // more bit than a failed login should give away. It fails like any other
    // bad login.
    const emailResult = Email.create(command.email);
    if (Result.isErr(emailResult)) {
      await this.burnTime(command.password);
      return Result.err(new AuthenticationError());
    }

    const now = new Date();

    const outcome = await this.unitOfWork.run<Outcome>(async (repositories) => {
      // Excludes soft-deleted users, which is the behaviour wanted here: a
      // deleted account must not be loggable into, and `findByEmail` already
      // encodes that. Worth noting rather than assuming, because the choice
      // between this and `findByIdIncludingDeleted` is a security decision
      // wearing the clothes of a method name.
      const user = await repositories.users.findByEmail(emailResult.value);
      if (user === undefined) {
        // Counted here and only here: there is no row to count against, so
        // without this the per-identifier budget never moves.
        await this.bruteForce?.recordFailure("login", command.email);
        await this.burnTime(command.password);
        return { kind: "failed" };
      }

      const credential = await repositories.credentials.findByUserId(user.id);
      if (credential === undefined) {
        // An SSO-only or passkey-only account. Legitimately has no password,
        // and must not reveal that by failing faster or differently than a
        // wrong password would.
        //
        // Also counted: like a missing user, nothing advances a `Credential`,
        // and a probe list of addresses that exist-but-have-no-password is the
        // same enumeration.
        await this.bruteForce?.recordFailure("login", command.email);
        await this.burnTime(command.password);
        return { kind: "failed" };
      }

      // Lockout is checked before verifying the password so a locked account does not cost a hash.
      // The decoy still runs so the faster path does not reveal that the account exists and is
      // under attack.
      if (credential.isLockedAt(now)) {
        await this.burnTime(command.password);
        // The counter keeps climbing during a lock rather than freezing at
        // the threshold. That is what makes the backoff exponential: each
        // further attempt earns a longer next lock, so a sustained campaign
        // collapses into impracticality within a few rounds.
        await repositories.credentials.save(
          credential.recordFailedAttempt(this.lockoutPolicy, now),
        );
        return { kind: "locked" };
      }

      const matches = await this.passwordHasher.verify(command.password, credential.passwordHash);
      if (!matches) {
        await repositories.credentials.save(
          credential.recordFailedAttempt(this.lockoutPolicy, now),
        );
        // Record failed login attempt for rate limiting
        await this.rateLimiter.recordFailure(rateLimitKey);
        return { kind: "failed" };
      }

      // Status is checked only after the password is confirmed, so a suspended account fails
      // exactly like a wrong password and does not reveal that it exists.
      //
      // `pending` users may sign in: email verification restricts what an account can do, not
      // whether its owner can authenticate.
      //
      // No failure is recorded here, because the password was correct.
      if (!CAN_AUTHENTICATE.has(user.status)) {
        return { kind: "failed" };
      }

      // Clearing the counter is what makes the threshold count *consecutive*
      // failures. Without it, five mistyped passwords spread over a year —
      // each followed by a successful login — would lock the account on the
      // fifth, which is indistinguishable from an attack only if you never
      // look at the gaps between them.
      //
      // Returns the same instance when there is nothing to clear, so the
      // common case does not write a row on every login.
      const cleared = credential.recordSuccessfulAttempt(now);
      if (cleared !== credential) {
        await repositories.credentials.save(cleared);
      }

      return { kind: "ok", user, credential: cleared };
    });

    if (outcome.kind === "locked") {
      return Result.err(new AccountLockedError());
    }
    if (outcome.kind === "failed") {
      return Result.err(new AuthenticationError());
    }
    // The owner proved who they are, so the run is over. Cleared outside the
    // transaction because a failed write here must not fail a login that
    // already succeeded — the worst case is one stale counter until the next
    // successful attempt.
    await this.bruteForce?.recordSuccess("login", command.email);

    const verified = { user: outcome.user, credential: outcome.credential };

    await this.rateLimiter.reset(rateLimitKey);

    // Outside the transaction: re-hashing is slow and unrelated to the read. It must also be
    // outside for correctness, because a failed write inside the transaction would mark it for
    // rollback and fail a login that already succeeded.
    const rehashed = await this.upgradeHashIfStale(verified.credential, command.password);

    if (this.mfaChecker !== undefined) {
      const policy = await this.mfaChecker.resolvePolicy(verified.user.id);
      const activeMethods = await this.mfaChecker.listActiveMethods(verified.user.id);

      if (policy === "required" && activeMethods.length === 0) {
        return Result.ok({
          user: verified.user,
          rehashed,
          status: "enrollment_required",
          userId: verified.user.id,
        });
      }

      if (
        policy === "required" ||
        (policy === "optional" && activeMethods.length > 0) ||
        activeMethods.length > 0
      ) {
        if (activeMethods.length > 0) {
          return Result.ok({
            user: verified.user,
            rehashed,
            status: "mfa_challenge",
            userId: verified.user.id,
            methods: activeMethods,
          });
        } else if (policy === "required") {
          return Result.ok({
            user: verified.user,
            rehashed,
            status: "enrollment_required",
            userId: verified.user.id,
          });
        }
      }
    }

    return Result.ok({ user: verified.user, rehashed });
  }

  /**
   * Verifies the candidate against a decoy hash and throws the answer away.
   *
   * The work is the point. See the class comment on timing.
   */
  private async burnTime(candidate: string): Promise<void> {
    await this.passwordHasher.verify(candidate, await decoy(this.passwordHasher));
  }

  /**
   * Re-hashes at current parameters when the stored hash is weaker. Failures are swallowed so they
   * never fail a successful login; the upgrade is retried on the next login.
   */
  private async upgradeHashIfStale(credential: Credential, plaintext: string): Promise<boolean> {
    if (!this.passwordHasher.needsRehash(credential.passwordHash)) {
      return false;
    }

    try {
      const upgraded = credential.withPasswordHash(await this.passwordHasher.hash(plaintext));
      await this.unitOfWork.run(async (repositories) => {
        await repositories.credentials.save(upgraded);
      });
      return true;
    } catch {
      return false;
    }
  }
}
