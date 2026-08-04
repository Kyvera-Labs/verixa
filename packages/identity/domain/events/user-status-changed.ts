import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { UserId, UserStatus } from "../entities/user.js";

/** Recorded whenever a `User`'s status transition succeeds (activate/suspend/delete). */
export class UserStatusChanged extends BaseDomainEvent {
  readonly eventName = "identity.user.status_changed";
  readonly previousStatus: UserStatus;
  readonly newStatus: UserStatus;

  constructor(userId: UserId, previousStatus: UserStatus, newStatus: UserStatus) {
    super(userId);
    this.previousStatus = previousStatus;
    this.newStatus = newStatus;
  }
}
