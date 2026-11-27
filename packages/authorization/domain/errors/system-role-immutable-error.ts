import { DomainError } from "@verixa/shared-kernel";

export type SystemRoleAction = "revoke" | "rename" | "delete";

/**
 * Thrown when an operation would revoke permissions from, or rename, a protected system role such
 * as `super-admin`, which guarantees administrative access cannot be locked out. Maps to HTTP 403.
 */
export class SystemRoleImmutableError extends DomainError {
  readonly code = "SYSTEM_ROLE_IMMUTABLE";
  readonly httpStatusHint = 403;
  readonly roleId: string;
  readonly roleName: string;
  readonly attemptedAction: SystemRoleAction;

  constructor(
    roleId: string,
    roleName: string,
    attemptedAction: SystemRoleAction,
    options?: ErrorOptions,
  ) {
    const actionDescription =
      attemptedAction === "revoke"
        ? "revoke permissions from"
        : attemptedAction === "rename"
          ? "rename"
          : "delete";

    super(
      `Cannot ${actionDescription} system role "${roleName}" (${roleId}): system roles are protected against modification to guarantee system recoverability.`,
      options,
    );
    this.roleId = roleId;
    this.roleName = roleName;
    this.attemptedAction = attemptedAction;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & {
    roleId: string;
    roleName: string;
    attemptedAction: SystemRoleAction;
  } {
    return {
      ...super.toJSON(),
      roleId: this.roleId,
      roleName: this.roleName,
      attemptedAction: this.attemptedAction,
    };
  }
}
