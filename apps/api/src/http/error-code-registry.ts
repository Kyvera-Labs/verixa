/**
 * Public API error codes and their HTTP status mapping.
 *
 * Keeping this table explicit prevents a new domain error from accidentally
 * inheriting a catch-all status or exposing an internal exception. When a
 * domain error is added, its public status belongs here as part of the API
 * contract.
 */
export const API_ERROR_CODES = {
  VALIDATION_ERROR: { status: 400 },
  INVALID_EVIDENCE: { status: 400 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  INVALID_STATUS_TRANSITION: { status: 409 },
  REVIEW_CLAIM_CONFLICT: { status: 409 },
  AUDIT_CHAIN_CONFLICT: { status: 409 },
  AUTHENTICATION_FAILED: { status: 401 },
  AUTHORIZATION_FAILED: { status: 403 },
  FORBIDDEN: { status: 403 },
  REVIEW_DECISION_NOT_PERMITTED: { status: 403 },
  SYSTEM_ROLE_IMMUTABLE: { status: 403 },
  AUDIT_ACCESS_DENIED: { status: 403 },
  AUDIT_QUEUE_FULL: { status: 429 },
  SIGNING_FAILED: { status: 502 },
  ANCHOR_FAILED: { status: 502 },
  ANCHOR_BALANCE_UNAVAILABLE: { status: 503 },
  AUDIT_READ_NOT_RECORDED: { status: 503 },
  INTERNAL_ERROR: { status: 500 },
  NOT_IMPLEMENTED: { status: 501 },
  RATE_LIMITED: { status: 429 },
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

export function isApiErrorCode(code: string): code is ApiErrorCode {
  return Object.hasOwn(API_ERROR_CODES, code);
}
