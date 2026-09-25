import type { Id } from "@verixa/shared-kernel";

import type { MfaMethodRepository } from "../../application/ports/mfa-method-repository.js";
import type { MfaMethod, MfaMethodId } from "../../domain/entities/mfa-method.js";

export class InMemoryMfaMethodRepository implements MfaMethodRepository {
  private readonly methods = new Map<string, MfaMethod>();

  save(method: MfaMethod): Promise<void> {
    this.methods.set(method.id, method);
    return Promise.resolve();
  }

  findById(id: MfaMethodId): Promise<MfaMethod | null> {
    return Promise.resolve(this.methods.get(id) ?? null);
  }

  findByUserId(userId: Id<"UserId">): Promise<MfaMethod[]> {
    return Promise.resolve(Array.from(this.methods.values()).filter((m) => m.userId === userId));
  }

  clear(): void {
    this.methods.clear();
  }
}
