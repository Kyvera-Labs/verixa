/**
 * Base class for expected, domain-meaningful failures. Every subclass
 * carries a stable machine-readable `code` (safe to branch on in client code
 * or translate for i18n, unlike `message`) and an `httpStatusHint` the
 * interface layer can use without re-deriving it from the error type.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatusHint: number;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }

  /**
   * `Error` instances don't serialize usefully with `JSON.stringify` by
   * default (`message` is a non-enumerable own property in V8) — `toJSON`
   * gives every domain error a predictable wire shape.
   */
  toJSON(): { code: string; message: string; httpStatusHint: number } {
    return { code: this.code, message: this.message, httpStatusHint: this.httpStatusHint };
  }
}

/** A request failed input validation. */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatusHint = 400;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;

  constructor(message: string, fieldErrors: Readonly<Record<string, readonly string[]>> = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & {
    fieldErrors: Readonly<Record<string, readonly string[]>>;
  } {
    return { ...super.toJSON(), fieldErrors: this.fieldErrors };
  }
}

/** The requested resource does not exist (or the caller may not know it does). */
export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
  readonly httpStatusHint = 404;
}

/** The request conflicts with the current state of the resource (e.g. a duplicate). */
export class ConflictError extends DomainError {
  readonly code = "CONFLICT";
  readonly httpStatusHint = 409;
}

/**
 * The caller is authenticated but not allowed to perform the action. Distinct from {@link
 * AuthenticationError} (401) and from {@link NotFoundError}, which some flows use instead to avoid
 * confirming that a resource exists. Use this when existence is not sensitive, for example reading
 * another user's session list.
 */
export class AuthorizationError extends DomainError {
  readonly code = "AUTHORIZATION_FAILED";
  readonly httpStatusHint = 403;
}

/**
 * Authentication failed, without saying why. The message is part of the security contract:
 * distinguishing "no such user" from "wrong password" would let callers enumerate accounts. One
 * error and one message for every failure reason, with no field errors. Maps to 401 (see
 * docs/security/authentication-flows.md).
 */
export class AuthenticationError extends DomainError {
  readonly code = "AUTHENTICATION_FAILED";
  readonly httpStatusHint = 401;

  constructor(message = "Invalid email or password.", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Authentication refused because the credential is temporarily locked after repeated failures.
 * Separate from {@link AuthenticationError} so logs and metrics can tell lockouts from bad
 * passwords, but rendered identically over HTTP (same 401, body and message), because only existing
 * accounts can be locked (see docs/security/authentication-flows.md).
 */
export class AccountLockedError extends DomainError {
  readonly code = "AUTHENTICATION_FAILED";
  readonly httpStatusHint = 401;

  constructor(message = "Invalid email or password.", options?: ErrorOptions) {
    super(message, options);
  }
}
