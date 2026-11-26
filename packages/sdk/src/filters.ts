/** Values the API accepts in a query string after serialization. */
export type QueryValue = string | number | boolean | Date;

/** A ready-to-send query object. `undefined` values are omitted by the client. */
export type QueryParams = Readonly<Record<string, string | undefined>>;

/**
 * Serializes named values into query params. Reused by every resource so the
 * rules for empty values and `Date` formatting are defined in one place.
 */
export class QueryParamsBuilder {
  readonly #params = new Map<string, string>();

  with(name: string, value: QueryValue | null | undefined): this {
    if (value === undefined || value === null) return this;

    const serialized = value instanceof Date ? value.toISOString() : String(value);
    if (serialized.trim() === "") return this;

    this.#params.set(name, serialized);
    return this;
  }

  build(): QueryParams {
    return Object.fromEntries(this.#params);
  }

  toSearchParams(): URLSearchParams {
    const search = new URLSearchParams();
    for (const [name, value] of this.#params) search.set(name, value);
    return search;
  }
}

/**
 * Filters accepted by `GET /v1/audit` in `apps/api/openapi/openapi.yaml`.
 * Only documented parameter names are exposed; adding a `status` filter here
 * without a contract change would silently send a param the route rejects.
 */
export interface AuditFilters {
  actorId(value: string | null | undefined): AuditFilters;
  subjectId(value: string | null | undefined): AuditFilters;
  from(value: Date | string | null | undefined): AuditFilters;
  to(value: Date | string | null | undefined): AuditFilters;
  build(): QueryParams;
}

export function createAuditFilters(): AuditFilters {
  const params = new QueryParamsBuilder();

  const filters: AuditFilters = {
    actorId(value) {
      params.with("actorId", value);
      return filters;
    },
    subjectId(value) {
      params.with("subjectId", value);
      return filters;
    },
    from(value) {
      params.with("from", value);
      return filters;
    },
    to(value) {
      params.with("to", value);
      return filters;
    },
    build() {
      return params.build();
    },
  };

  return filters;
}

/** Alias so call sites read as an expression: `auditFilters().actorId(id)`. */
export const auditFilters = createAuditFilters;

export type SortDirection = "asc" | "desc";

export interface Sort<TField extends string = string> {
  readonly field: TField;
  readonly direction?: SortDirection | undefined;
}

export interface SortParamNames {
  readonly field?: string | undefined;
  readonly direction?: string | undefined;
}

/**
 * Builds sort params for a resource that documents sorting. The parameter
 * names are arguments rather than global constants because no current REST
 * endpoint documents sort params, and sending unsupported ones would fail
 * strict query validation.
 */
export function sortParams<TField extends string>(
  sort: Sort<TField> | null | undefined,
  names: SortParamNames = {},
): QueryParams {
  if (sort === null || sort === undefined) return {};

  return new QueryParamsBuilder()
    .with(names.field ?? "sortBy", sort.field)
    .with(names.direction ?? "sortOrder", sort.direction ?? "asc")
    .build();
}
