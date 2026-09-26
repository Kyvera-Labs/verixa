import type { MfaMethod, MfaMethodId, UserId } from "../../domain/entities/mfa-method.js";

export interface MfaMethodRepository {
  save(method: MfaMethod): Promise<void>;
  findById(id: MfaMethodId): Promise<MfaMethod | undefined>;
  findActiveByUserId(userId: UserId): Promise<MfaMethod[]>;
  findPendingByUserId(userId: UserId): Promise<MfaMethod[]>;
  delete(id: MfaMethodId): Promise<void>;
}
