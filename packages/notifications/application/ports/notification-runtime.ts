import type { DomainEventPublisher } from "@verixa/shared-kernel";

/** A trigger-event subscriber that is ready to be registered during startup. */
export interface NotificationSubscriber {
  register(publisher: DomainEventPublisher): void;
}

/** Lifecycle contract for the delivery worker. */
export interface NotificationWorker {
  /** Starts the worker before the application accepts requests. */
  start(): void;
  /** Stops the worker and allows it to drain before process shutdown. */
  stop(): Promise<void>;
  health(): { readonly running: boolean; readonly lastError?: string };
}

export interface NotificationComposition {
  readonly subscribers: readonly NotificationSubscriber[];
  readonly worker: NotificationWorker;
}
