import type { VerificationRetentionStore } from "../../application/ports/verification-retention-store.js";
import type { VerificationRequest } from "../../domain/entities/verification-request.js";

interface Entry {
  readonly request: VerificationRequest;
  archived: boolean;
}

/**
 * Verification retention store over in-memory requests, satisfying the same
 * port a database-backed store will. A database adapter is follow-up work.
 */
export class InMemoryVerificationRetentionStore implements VerificationRetentionStore {
  private readonly entries = new Map<string, Entry>();

  constructor(requests: readonly VerificationRequest[] = []) {
    for (const request of requests) this.entries.set(request.id, { request, archived: false });
  }

  has(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  isArchived(requestId: string): boolean {
    return this.entries.get(requestId)?.archived ?? false;
  }

  findDecidedBefore(params: {
    organizationId: string;
    decidedBefore: Date;
    action: "delete" | "archive";
    limit: number;
  }): Promise<readonly { readonly id: string }[]> {
    const found = [...this.entries.values()]
      .filter(({ request }) => request.organizationId === params.organizationId)
      .filter(({ request }) => {
        const decidedAt = request.decision?.decidedAt;
        return (
          request.isTerminal &&
          decidedAt !== undefined &&
          decidedAt.getTime() <= params.decidedBefore.getTime()
        );
      })
      .filter(({ archived }) => !(params.action === "archive" && archived))
      .sort(
        (a, b) =>
          (a.request.decision?.decidedAt.getTime() ?? 0) -
          (b.request.decision?.decidedAt.getTime() ?? 0),
      )
      .slice(0, params.limit)
      .map(({ request }) => ({ id: request.id }));
    return Promise.resolve(found);
  }

  deleteById(organizationId: string, requestId: string): Promise<boolean> {
    const entry = this.entries.get(requestId);
    if (entry?.request.organizationId !== organizationId) return Promise.resolve(false);
    return Promise.resolve(this.entries.delete(requestId));
  }

  archiveById(organizationId: string, requestId: string): Promise<boolean> {
    const entry = this.entries.get(requestId);
    if (entry === undefined || entry.request.organizationId !== organizationId || entry.archived) {
      return Promise.resolve(false);
    }
    entry.archived = true;
    return Promise.resolve(true);
  }
}
