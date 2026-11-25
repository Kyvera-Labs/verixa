import type {
  DeadLetterNotification,
  DeadLetterStore,
} from "../../application/ports/dead-letter-store.js";

/** Deterministic adapter for unit tests and local composition. */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterNotification>();

  save(entry: DeadLetterNotification): Promise<void> {
    this.entries.set(entry.notification.id, freezeEntry(entry));
    return Promise.resolve();
  }

  find(notificationId: string): Promise<DeadLetterNotification | undefined> {
    return Promise.resolve(this.entries.get(notificationId));
  }

  list(): Promise<readonly DeadLetterNotification[]> {
    return Promise.resolve([...this.entries.values()]);
  }

  remove(notificationId: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(notificationId));
  }
}

function freezeEntry(entry: DeadLetterNotification): DeadLetterNotification {
  return Object.freeze({
    ...entry,
    notification: Object.freeze({ ...entry.notification }),
    failures: Object.freeze(entry.failures.map((failure) => Object.freeze({ ...failure }))),
  });
}
