import type { QueryParams } from "./filters.js";
import { AuditResource } from "./resources/audit.js";
import { IdentityResource, type IdentityResourceOptions } from "./resources/identity.js";

/** The minimal surface a resource needs. Kept small so tests can inject a fake. */
export interface RequestClient {
  get<T>(path: string, query?: QueryParams): Promise<T>;
}

export interface VerixaClientOptions {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Supply a custom fetch implementation (proxies, tests, edge runtimes). */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly identity?: IdentityResourceOptions | undefined;
}

/**
 * Small HTTP core for the resource clients in this package. Interceptors,
 * typed errors, and auth are deliberately left to the issues that own them;
 * this is only enough transport for pagination and filters to be exercised.
 */
export class VerixaClient implements RequestClient {
  readonly audit: AuditResource;
  readonly identity: IdentityResource;

  readonly #baseUrl: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: VerixaClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#headers = { Accept: "application/json", ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.audit = new AuditResource(this);
    this.identity = new IdentityResource(this, options.identity);
  }

  async get<T>(path: string, query: QueryParams = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }

    const response = await this.#fetch(url, { headers: this.#headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Verixa API request failed with ${String(response.status)}: ${body.slice(0, 500)}`,
      );
    }

    return (await response.json()) as T;
  }
}
