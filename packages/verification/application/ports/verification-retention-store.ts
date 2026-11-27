/**
 * Storage operations for verification retention. Only finally decided requests (approved or
 * rejected) are candidates; live work never is, however old. Every method is scoped to
 * `organizationId`.
 */
export interface VerificationRetentionStore {
  /**
   * Decided requests of the organization whose decision was made at or before
   * `decidedBefore` and that have not already been `action`-ed. At most
   * `limit`, oldest decision first. `archive` keeps the request, so an
   * implementation must exclude requests it already archived.
   */
  findDecidedBefore(params: {
    organizationId: string;
    decidedBefore: Date;
    action: "delete" | "archive";
    limit: number;
  }): Promise<readonly { readonly id: string }[]>;

  /** Removes the request and its evidence references. `false` when it did not exist. */
  deleteById(organizationId: string, requestId: string): Promise<boolean>;

  /**
   * Moves the request out of the active store while keeping it retrievable.
   * `false` when it was already archived or did not exist.
   */
  archiveById(organizationId: string, requestId: string): Promise<boolean>;
}
