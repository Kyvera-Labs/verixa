import { createId, type Id } from "@verixa/shared-kernel";

import type { MfaMethodType } from "../value-objects/mfa-method-type.js";

export type MfaMethodId = Id<"MfaMethodId">;
export type MfaMethodStatus = "pending" | "active" | "disabled";

export interface MfaMethodProps {
  readonly id: MfaMethodId;
  readonly userId: Id<"UserId">;
  readonly type: MfaMethodType;
  readonly status: MfaMethodStatus;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date | undefined;
  readonly failedAttempts: number;
  readonly lockedUntil?: Date | undefined;
}

export class MfaMethod {
  private constructor(public readonly props: MfaMethodProps) {}

  get id(): MfaMethodId {
    return this.props.id;
  }

  get userId(): Id<"UserId"> {
    return this.props.userId;
  }

  get type(): MfaMethodType {
    return this.props.type;
  }

  get status(): MfaMethodStatus {
    return this.props.status;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get lastUsedAt(): Date | undefined {
    return this.props.lastUsedAt;
  }

  get failedAttempts(): number {
    return this.props.failedAttempts;
  }

  get lockedUntil(): Date | undefined {
    return this.props.lockedUntil;
  }

  static createPending(
    userId: Id<"UserId">,
    type: MfaMethodType,
    now: Date = new Date(),
  ): MfaMethod {
    return new MfaMethod({
      id: createId<"MfaMethodId">(),
      userId,
      type,
      status: "pending",
      createdAt: now,
      failedAttempts: 0,
      lockedUntil: undefined,
      lastUsedAt: undefined,
    });
  }

  static createActive(
    userId: Id<"UserId">,
    type: MfaMethodType,
    now: Date = new Date(),
  ): MfaMethod {
    return new MfaMethod({
      id: createId<"MfaMethodId">(),
      userId,
      type,
      status: "active",
      createdAt: now,
      failedAttempts: 0,
      lockedUntil: undefined,
      lastUsedAt: undefined,
    });
  }

  static reconstitute(props: MfaMethodProps): MfaMethod {
    return new MfaMethod(props);
  }

  activate(): MfaMethod {
    if (this.props.status !== "pending") {
      throw new Error("Only pending methods can be activated.");
    }
    return new MfaMethod({
      ...this.props,
      status: "active",
      failedAttempts: 0,
      lockedUntil: undefined,
    });
  }

  disable(): MfaMethod {
    return new MfaMethod({
      ...this.props,
      status: "disabled",
    });
  }

  recordUse(now: Date = new Date()): MfaMethod {
    if (this.props.status !== "active") {
      throw new Error("Only active methods can satisfy an MFA challenge.");
    }
    return new MfaMethod({
      ...this.props,
      lastUsedAt: now,
      failedAttempts: 0,
      lockedUntil: undefined,
    });
  }

  recordFailedAttempt(now: Date = new Date()): MfaMethod {
    const attempts = this.props.failedAttempts + 1;
    const lockDurationMs = attempts >= 5 ? 60 * 1000 * Math.pow(2, attempts - 5) : 0;
    const lockedUntil =
      lockDurationMs > 0
        ? new Date(now.getTime() + Math.min(lockDurationMs, 60 * 60 * 1000))
        : undefined;

    return new MfaMethod({
      ...this.props,
      failedAttempts: attempts,
      lockedUntil,
    });
  }

  isLockedAt(now: Date = new Date()): boolean {
    if (!this.props.lockedUntil) return false;
    return now.getTime() < this.props.lockedUntil.getTime();
  }
}
