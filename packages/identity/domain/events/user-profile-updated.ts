import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { UserId } from "../entities/user.js";

/** Recorded whenever a `User`'s display name or person name is updated (see `User.updateProfile`). */
export class UserProfileUpdated extends BaseDomainEvent {
  readonly eventName = "identity.user.profile_updated";

  constructor(userId: UserId) {
    super(userId);
  }
}
