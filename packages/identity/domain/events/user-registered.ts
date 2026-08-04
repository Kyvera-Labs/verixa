import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { UserId } from "../entities/user.js";

/** Recorded once, when a new `User` is registered (see `User.register`). */
export class UserRegistered extends BaseDomainEvent {
  readonly eventName = "identity.user.registered";
  readonly email: string;

  constructor(userId: UserId, email: string) {
    super(userId);
    this.email = email;
  }
}
