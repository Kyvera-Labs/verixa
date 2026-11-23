import {
  MfaMethod,
  type MfaMethodId,
  type MfaMethodStatus,
  type MfaMethodType,
  type UserId,
} from "@verixa/mfa";
import { asId, createId } from "@verixa/shared-kernel";

export interface MfaMethodFactoryOptions {
  id?: MfaMethodId | string;
  userId?: UserId | string;
  type?: MfaMethodType;
  status?: MfaMethodStatus;
  secret?: string | null;
  now?: Date;
}

/**
 * Creates a domain-valid `MfaMethod` entity with sensible defaults and overrides.
 */
export function makeMfaMethod(overrides: MfaMethodFactoryOptions = {}): MfaMethod {
  const userId = (overrides.userId
    ? typeof overrides.userId === "string"
      ? asId<"UserId">(overrides.userId)
      : overrides.userId
    : createId<"UserId">()) as unknown as UserId;

  const type = overrides.type ?? "totp";
  const status = overrides.status ?? "active";
  const now = overrides.now ?? new Date();

  let method =
    status === "active"
      ? MfaMethod.createActive(userId, type, now)
      : MfaMethod.create(userId, type, overrides.secret ?? "JBSWY3DPEHPK3PXP", now);

  if (overrides.id) {
    const id = (typeof overrides.id === "string"
      ? asId<"MfaMethodId">(overrides.id)
      : overrides.id) as unknown as MfaMethodId;
    method = MfaMethod.load({
      id,
      userId: method.userId,
      type: method.type,
      status: method.status,
      secret: method.secret,
      lastUsedAt: method.lastUsedAt,
      createdAt: method.createdAt,
      updatedAt: method.updatedAt,
      failedAttempts: method.failedAttempts,
      lockedUntil: method.lockedUntil,
      lastUsedStep: method.lastUsedStep,
    });
  }

  return method;
}
