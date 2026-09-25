import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

import type { MfaMethodType } from "../value-objects/mfa-method-type.js";

export type MfaMethodId = Id<"MfaMethodId">;
export type UserId = Id<"UserId">;
export type MfaMethodStatus = "pending" | "active" | "disabled";

interface MfaMethodProps {
  readonly id: MfaMethodId;
  readonly userId: UserId;
  readonly type: MfaMethodType;
  readonly status: MfaMethodStatus;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date | undefined;
}

export class MfaMethod {
  readonly id: MfaMethodId;
  readonly userId: UserId;
  readonly type: MfaMethodType;
  readonly status: MfaMethodStatus;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | undefined;

  private constructor(props: MfaMethodProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.type = props.type;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.lastUsedAt = props.lastUsedAt;
  }

  static enroll(params: { userId: UserId; type: MfaMethodType }): MfaMethod {
    return new MfaMethod({
      id: createId<"MfaMethodId">(),
      userId: params.userId,
      type: params.type,
      status: "pending",
      createdAt: new Date(),
    });
  }

  static reconstitute(props: MfaMethodProps): MfaMethod {
    return new MfaMethod(props);
  }

  activate(): Result<MfaMethod, ValidationError> {
    if (this.status === "active") {
      return Result.err(
        new ValidationError(`Method is already active.`, { status: ["invalid_state"] }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        status: "active",
      }),
    );
  }

  disable(): Result<MfaMethod, ValidationError> {
    if (this.status === "disabled") {
      return Result.err(
        new ValidationError(`Method is already disabled.`, { status: ["invalid_state"] }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        status: "disabled",
      }),
    );
  }

  recordUse(): Result<MfaMethod, ValidationError> {
    if (this.status === "pending") {
      return Result.err(
        new ValidationError(`A pending MFA method cannot satisfy a challenge.`, {
          status: ["pending_cannot_challenge"],
        }),
      );
    }
    if (this.status === "disabled") {
      return Result.err(
        new ValidationError(`A disabled MFA method cannot satisfy a challenge.`, {
          status: ["disabled_cannot_challenge"],
        }),
      );
    }
    return Result.ok(
      new MfaMethod({
        ...this,
        lastUsedAt: new Date(),
      }),
    );
  }
}
