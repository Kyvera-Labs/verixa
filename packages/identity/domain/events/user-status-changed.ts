import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { UserId, UserStatus } from "../entities/user.js";

/**
 * Recorded whenever a `User`'s status transition succeeds
 * (activate/suspend/delete). `reason` is set by admin-triggered transitions
 * (e.g. `SuspendUser`/`ReactivateUser`, Issue 033) that require one for the
 * audit trail; it's `undefined` for self-service transitions that don't
 * (e.g. activation via email verification).
 */
export class UserStatusChanged extends BaseDomainEvent {
  readonly eventName = "identity.user.status_changed";
  readonly previousStatus: UserStatus;
  readonly newStatus: UserStatus;
  readonly reason: string | undefined;

  constructor(userId: UserId, previousStatus: UserStatus, newStatus: UserStatus, reason?: string) {
    super(userId);
    this.previousStatus = previousStatus;
    this.newStatus = newStatus;
    this.reason = reason;
  }
}
