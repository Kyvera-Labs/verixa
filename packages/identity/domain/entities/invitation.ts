import { randomUUID } from "node:crypto";

import {
  createId,
  type DomainEvent,
  type Id,
  Result,
  ValidationError,
} from "@verixa/shared-kernel";

import { OrganizationInvitationCreated } from "../events/organization-invitation-created.js";
import type { Email } from "../value-objects/email.js";

import type { OrganizationId } from "./organization.js";
import type { UserId } from "./user.js";

export type InvitationId = Id<"InvitationId">;

export type InvitationStatus = "pending" | "accepted" | "revoked";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface InvitationProps {
  readonly id: InvitationId;
  readonly organizationId: OrganizationId;
  readonly email: Email;
  readonly invitedByUserId: UserId;
  readonly token: string;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | undefined;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * A pending invitation for someone to join an `Organization`. This is a
 * **domain-level skeleton**: it models the full invitation lifecycle
 * (issued, single-use, expires) now, in Phase 02, even though nothing sends
 * the invitation email yet — that adapter doesn't exist until Phase 14
 * (Notifications). Modeling intent before the delivery mechanism exists
 * means the notifications work later only has to *send* an already-correct
 * domain concept, not redesign identity's org-membership model around it.
 * See `docs/guides/domain-modeling.md`.
 */
export class Invitation {
  readonly id: InvitationId;
  readonly organizationId: OrganizationId;
  readonly email: Email;
  readonly invitedByUserId: UserId;
  readonly token: string;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | undefined;
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: InvitationProps) {
    this.id = props.id;
    this.organizationId = props.organizationId;
    this.email = props.email;
    this.invitedByUserId = props.invitedByUserId;
    this.token = props.token;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.expiresAt = props.expiresAt;
    this.acceptedAt = props.acceptedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  /**
   * Issues a new pending invitation. `token` is a random, unguessable
   * opaque string distinct from `id` — `id` is a normal database key that
   * may appear in URLs/logs, while `token` is the actual bearer credential
   * that proves whoever holds it was the intended recipient (mailed to
   * `email`, once Phase 14 exists). Using the entity's own `id` as that
   * secret would conflate an identifier with a credential.
   */
  static create(params: {
    organizationId: OrganizationId;
    email: Email;
    invitedByUserId: UserId;
    ttlMs?: number;
  }): Invitation {
    const now = new Date();
    const id = createId<"InvitationId">();
    return new Invitation({
      id,
      organizationId: params.organizationId,
      email: params.email,
      invitedByUserId: params.invitedByUserId,
      token: randomUUID(),
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)),
      acceptedAt: undefined,
      domainEvents: [
        new OrganizationInvitationCreated(id, params.organizationId, params.email.value),
      ],
    });
  }

  /** Rebuilds an `Invitation` from already-trusted data (e.g. a database row). Never carries pending domain events — see `User.reconstitute`. */
  static reconstitute(props: InvitationProps): Invitation {
    return new Invitation({ ...props, domainEvents: [] });
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  /**
   * Accepts the invitation, exactly once. An invitation that's already been
   * accepted, was revoked, or has passed its `expiresAt` cannot be accepted
   * again — that's what "single-use" means here: not a counter, but a
   * status transition with no way back to `pending`.
   */
  accept(now: Date = new Date()): Result<Invitation, ValidationError> {
    if (this.status === "accepted") {
      return Result.err(
        new ValidationError("This invitation has already been accepted.", {
          status: ["already_accepted"],
        }),
      );
    }

    if (this.status === "revoked") {
      return Result.err(
        new ValidationError("This invitation has been revoked.", { status: ["revoked"] }),
      );
    }

    if (this.isExpired(now)) {
      return Result.err(
        new ValidationError("This invitation has expired.", { status: ["expired"] }),
      );
    }

    return Result.ok(
      new Invitation({ ...this, status: "accepted", acceptedAt: now, domainEvents: [] }),
    );
  }

  /** Revokes a pending invitation. Idempotent: revoking an already-revoked or already-accepted invitation is a no-op, not an error. */
  revoke(): Invitation {
    if (this.status !== "pending") {
      return this;
    }
    return new Invitation({ ...this, status: "revoked", domainEvents: [] });
  }

  /** Returns the domain event(s) produced by the action that created this specific `Invitation` instance. See `User.pullDomainEvents`. */
  pullDomainEvents(): readonly DomainEvent[] {
    return this.domainEvents;
  }
}
