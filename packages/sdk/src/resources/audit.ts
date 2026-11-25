import type { RequestClient } from "../client.js";
import type { QueryParams } from "../filters.js";
import { paginate, type Page, type PaginationOptions } from "../pagination.js";

/** Public shape of an audit entry returned by `GET /v1/audit`. */
export interface AuditEvent {
  readonly id: string;
  readonly sequence: number;
  readonly action: string;
  readonly actorId: string | null;
  readonly subjectId: string | null;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ListAuditEventsOptions extends PaginationOptions {
  /** Output of `auditFilters()`; only documented query params are accepted. */
  readonly filter?: QueryParams | undefined;
}

export class AuditResource {
  readonly #client: RequestClient;

  constructor(client: RequestClient) {
    this.#client = client;
  }

  /** Lazily walks every page of the organization's audit log. */
  queryEvents(options: ListAuditEventsOptions = {}): AsyncIterableIterator<AuditEvent> {
    const { filter, ...pagination } = options;
    const client = this.#client;

    return paginate(
      ({ cursor, limit }) =>
        client.get<Page<AuditEvent>>("/v1/audit", {
          ...filter,
          cursor,
          limit: String(limit),
        }),
      pagination,
    );
  }

  /** Alias for `queryEvents`, matching the other list resource methods. */
  listEvents(options: ListAuditEventsOptions = {}): AsyncIterableIterator<AuditEvent> {
    return this.queryEvents(options);
  }
}
