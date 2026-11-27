/**
 * Decides whether an actor may perform an MFA recovery. Recovery can remove every factor from an
 * account, so it is never self-service and requires elevated privilege, such as an administrator or
 * an organization-configured re-verification. The decision belongs to RBAC, so MFA only asks for
 * yes or no.
 */
export interface MfaRecoveryAuthorizer {
  /** Whether `actorId` may recover another user's MFA access. */
  canRecoverMfaAccess(actorId: string): Promise<boolean>;
}
