export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginate,
  paginatePages,
  type Page,
  type PageFetcher,
  type PageRequest,
  type PaginationOptions,
} from "./src/pagination.js";

export {
  QueryParamsBuilder,
  auditFilters,
  createAuditFilters,
  sortParams,
  type AuditFilters,
  type QueryParams,
  type QueryValue,
  type Sort,
  type SortDirection,
  type SortParamNames,
} from "./src/filters.js";

export { VerixaClient, type RequestClient, type VerixaClientOptions } from "./src/client.js";

export {
  AuditResource,
  type AuditEvent,
  type ListAuditEventsOptions,
} from "./src/resources/audit.js";

export {
  IdentityResource,
  type IdentityResourceOptions,
  type ListUsersOptions,
  type SdkUser,
} from "./src/resources/identity.js";
