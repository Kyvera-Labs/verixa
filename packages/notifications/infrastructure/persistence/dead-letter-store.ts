import type {
  DeadLetterNotification,
  DeadLetterStore,
} from "../../application/ports/dead-letter-store.js";

/** Deterministic adapter for unit tests and local composition. */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterNotification>();

  async save(entry: DeadLetterNotification): Promise<void> {
    this.entries.set(entry.notification.id, freezeEntry(entry));
  }

  async find(notificationId: string): Promise<DeadLetterNotification | undefined> {
    return this.entries.get(notificationId);
  }

  async list(): Promise<readonly DeadLetterNotification[]> {
    return [...this.entries.values()];
  }

  async remove(notificationId: string): Promise<boolean> {
    return this.entries.delete(notificationId);
  }
}

function freezeEntry(entry: DeadLetterNotification): DeadLetterNotification {
  return Object.freeze({
    ...entry,
    notification: Object.freeze({ ...entry.notification }),
    failures: Object.freeze(entry.failures.map((failure) => Object.freeze({ ...failure }))),
  });
}
