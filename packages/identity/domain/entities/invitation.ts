import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

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

/**
 * An invitation plus the one-time raw token issued with it. The token is not
 * a field on {@link Invitation} because it is never stored — see
 * {@link Invitation.create}.
 */
export interface IssuedInvitation {
  readonly invitation: Invitation;
  readonly token: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface InvitationProps {
  readonly id: InvitationId;
  readonly organizationId: OrganizationId;
  readonly email: Email;
  readonly invitedByUserId: UserId;
  readonly tokenHash: string;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | undefined;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * A pending invitation to join an `Organization`: issued, single-use and expiring (see
 * docs/guides/domain-modeling.md).
 */
export class Invitation {
  readonly id: InvitationId;
  readonly organizationId: OrganizationId;
  readonly email: Email;
  readonly invitedByUserId: UserId;
  readonly tokenHash: string;
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
    this.tokenHash = props.tokenHash;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.expiresAt = props.expiresAt;
    this.acceptedAt = props.acceptedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  /** SHA-256 of a raw token, hex-encoded. The only form ever persisted. */
  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /**
   * Issues a new pending invitation. The raw token is returned alongside the invitation, not stored
   * on it: only {@link tokenHash} is persisted, so the token exists only in this return value and
   * the recipient's email. The token is separate from `id`, which may appear in URLs and logs.
   */
  static create(params: {
    organizationId: OrganizationId;
    email: Email;
    invitedByUserId: UserId;
    ttlMs?: number;
  }): IssuedInvitation {
    const now = new Date();
    const id = createId<"InvitationId">();
    const token = randomUUID();
    const invitation = new Invitation({
      id,
      organizationId: params.organizationId,
      email: params.email,
      invitedByUserId: params.invitedByUserId,
      tokenHash: Invitation.hashToken(token),
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)),
      acceptedAt: undefined,
      domainEvents: [
        new OrganizationInvitationCreated(id, params.organizationId, params.email.value),
      ],
    });

    return { invitation, token };
  }

  /**
   * Whether `token` is this invitation's raw token, compared with {@link timingSafeEqual} so timing
   * does not reveal how much of a guess matched.
   */
  matchesToken(token: string): boolean {
    const candidate = Buffer.from(Invitation.hashToken(token), "hex");
    const actual = Buffer.from(this.tokenHash, "hex");
    return candidate.length === actual.length && timingSafeEqual(candidate, actual);
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
