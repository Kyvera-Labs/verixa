import type { Id } from "@verixa/shared-kernel";

import type { MfaMethod, MfaMethodId } from "../../domain/entities/mfa-method.js";

export interface MfaMethodRepository {
  save(method: MfaMethod): Promise<void>;
  findById(id: MfaMethodId): Promise<MfaMethod | null>;
  findByUserId(userId: Id<"UserId">): Promise<MfaMethod[]>;
}
