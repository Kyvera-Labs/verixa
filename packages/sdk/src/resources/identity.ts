import type { RequestClient } from "../client.js";
import type { QueryParams } from "../filters.js";
import { paginate, type Page, type PaginationOptions } from "../pagination.js";

/** Minimal user shape used by the paginated identity collection. */
export interface SdkUser {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
}

export interface IdentityResourceOptions {
  /** Override when the deployment publishes the collection under another path. */
  readonly listUsersPath?: string | undefined;
}

export interface ListUsersOptions extends PaginationOptions {
  readonly filter?: QueryParams | undefined;
}

export class IdentityResource {
  readonly #client: RequestClient;
  readonly #listUsersPath: string;

  constructor(client: RequestClient, options: IdentityResourceOptions = {}) {
    this.#client = client;
    this.#listUsersPath = options.listUsersPath ?? "/v1/identity/users";
  }

  /**
   * Lazily walks the user collection.
   *
   * The route is still introduced by the typed resource-client issue; this
   * method owns only the path and page protocol, so an injected `RequestClient`
   * exercises the same behavior the HTTP client will once the route lands.
   */
  listUsers(options: ListUsersOptions = {}): AsyncIterableIterator<SdkUser> {
    const { filter, ...pagination } = options;
    const client = this.#client;
    const path = this.#listUsersPath;

    return paginate(
      ({ cursor, limit }) =>
        client.get<Page<SdkUser>>(path, {
          ...filter,
          cursor,
          limit: String(limit),
        }),
      pagination,
    );
  }
}
