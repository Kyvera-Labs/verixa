import type { Invitation } from "@verixa/identity";

import { makeInvitation, type InvitationFactoryOptions } from "../factories/invitation.js";

import { orThrowDomainError } from "./domain-result.js";

type InvitationStep = (invitation: Invitation, now: Date) => Invitation;

/**
 * Fluent, immutable builder for the `Invitation` entity (Issue 419).
 *
 * Starts from {@link makeInvitation} in `pending` and reaches every other
 * status through the entity's own transitions — `accept()` and `revoke()` —
 * rather than the factory's `status` override, which sets the field directly.
 * That is what lets `aPendingInvitation().expired().accepted()` fail with the
 * domain's `ValidationError` ("This invitation has expired.") instead of
 * quietly producing an accepted-after-expiry invitation no code path can
 * create.
 */
export class InvitationBuilder {
  private constructor(
    private readonly options: InvitationFactoryOptions,
    private readonly steps: readonly InvitationStep[],
  ) {}

  /** Entry point: a pending invitation with the default seven-day lifetime. */
  static create(): InvitationBuilder {
    return new InvitationBuilder({ status: "pending" }, []);
  }

  /** The invitee's address. Validated by the `Email` value object at `build()`. */
  sentTo(email: string): InvitationBuilder {
    return this.withOptions({ email });
  }

  /** The organization the invitee would join. */
  toOrganization(organizationId: string): InvitationBuilder {
    return this.withOptions({ organizationId });
  }

  /** The member who sent the invitation. */
  invitedBy(userId: string): InvitationBuilder {
    return this.withOptions({ invitedByUserId: userId });
  }

  /** Still valid for `ttlMs` from build time. */
  expiringIn(ttlMs: number): InvitationBuilder {
    return this.withOptions({ ttlMs });
  }

  /** Its `expiresAt` has already passed. Time-based, not a status — the domain derives it. */
  expired(): InvitationBuilder {
    return this.withOptions({ ttlMs: -1 });
  }

  /** The invitee accepted it. Refused by the domain once revoked, accepted, or expired. */
  accepted(): InvitationBuilder {
    return this.withStep((invitation, now) => orThrowDomainError(invitation.accept(now)));
  }

  /** An admin withdrew it. A no-op on an invitation that is no longer pending. */
  revoked(): InvitationBuilder {
    return this.withStep((invitation) => invitation.revoke());
  }

  /** Builds a fresh, domain-valid `Invitation` by replaying the chain through the entity. */
  build(now: Date = new Date()): Invitation {
    // `now` reaches the factory too: expiry is `createdAt + ttl`, so judging
    // it against a different clock than the one that set it would make
    // `.expired()` depend on when the suite happens to run.
    const initial = makeInvitation({ ...this.options, now });
    return this.steps.reduce((invitation, step) => step(invitation, now), initial);
  }

  private withOptions(options: InvitationFactoryOptions): InvitationBuilder {
    return new InvitationBuilder({ ...this.options, ...options }, this.steps);
  }

  private withStep(step: InvitationStep): InvitationBuilder {
    return new InvitationBuilder(this.options, [...this.steps, step]);
  }
}

/** `aPendingInvitation().sentTo('new@example.com').accepted().build()` */
export function aPendingInvitation(): InvitationBuilder {
  return InvitationBuilder.create();
}
