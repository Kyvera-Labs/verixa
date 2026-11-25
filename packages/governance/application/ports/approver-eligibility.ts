/**
 * Answers whether a user may sign off as a given approver role.
 *
 * The approval chain trusts this answer entirely, so implementations must
 * decide from server-side state (role assignments, permissions). A role name
 * that a client merely asserts is not evidence. A failed lookup must answer
 * `false`: when in doubt the approval is refused.
 */
export interface ApproverEligibility {
  canApproveAs(userId: string, organizationId: string, role: string): Promise<boolean>;
}
