import type { SessionRetentionStore } from "../../application/ports/session-retention-store.js";
import type { Session } from "../../domain/entities/session.js";

interface Entry {
  readonly session: Session;
  anonymized: boolean;
}

/**
 * Session retention store over in-memory sessions, satisfying the same port a
 * database-backed store will. A database adapter is follow-up work; until then
 * this is what tests and single-process development use.
 */
export class InMemorySessionRetentionStore implements SessionRetentionStore {
  private readonly entries = new Map<string, Entry>();

  constructor(sessions: readonly Session[] = []) {
    for (const session of sessions) this.add(session);
  }

  add(session: Session): void {
    this.entries.set(session.id, { session, anonymized: false });
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  isAnonymized(sessionId: string): boolean {
    return this.entries.get(sessionId)?.anonymized ?? false;
  }

  findEndedBefore(params: {
    userIds: readonly string[];
    endedBefore: Date;
    action: "delete" | "anonymize";
    limit: number;
  }): Promise<readonly { readonly id: string }[]> {
    const users = new Set(params.userIds);
    const found = [...this.entries.values()]
      .filter(({ session }) => users.has(session.userId))
      .filter(({ session }) => endedAt(session).getTime() <= params.endedBefore.getTime())
      .filter(({ anonymized }) => !(params.action === "anonymize" && anonymized))
      .sort((a, b) => endedAt(a.session).getTime() - endedAt(b.session).getTime())
      .slice(0, params.limit)
      .map(({ session }) => ({ id: session.id }));
    return Promise.resolve(found);
  }

  ownerOf(sessionId: string): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(sessionId)?.session.userId);
  }

  deleteById(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(sessionId));
  }

  anonymizeById(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.anonymized) return Promise.resolve(false);
    entry.anonymized = true;
    return Promise.resolve(true);
  }
}

/** A session ends when it is revoked or reaches its absolute expiry, whichever is first. */
function endedAt(session: Session): Date {
  return session.revokedAt !== undefined && session.revokedAt < session.expiresAt
    ? session.revokedAt
    : session.expiresAt;
}
