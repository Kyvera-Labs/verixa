interface Ok<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface Err<E> {
  readonly kind: "err";
  readonly error: E;
}

/**
 * A value that is either a successful `T` or an expected failure `E`,
 * returned instead of thrown so callers are forced to handle both cases.
 */
export type Result<T, E> = Ok<T> | Err<E>;

function ok<T>(value: T): Result<T, never> {
  return { kind: "ok", value };
}

function err<E>(error: E): Result<never, E> {
  return { kind: "err", error };
}

function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.kind === "ok";
}

function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.kind === "err";
}

/** Transforms the success value, leaving an `Err` untouched. */
function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return isOk(result) ? ok(fn(result.value)) : result;
}

/**
 * Chains a step that itself returns a `Result`, without nesting
 * `Result<Result<U, E>, E>`. Short-circuits on the first `Err`.
 */
function flatMap<T, E, U>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return isOk(result) ? fn(result.value) : result;
}

/** Exhaustively unwraps a `Result` into a single value, handling both cases. */
function match<T, E, U>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U },
): U {
  return isOk(result) ? handlers.ok(result.value) : handlers.err(result.error);
}

export const Result = { ok, err, isOk, isErr, map, flatMap, match };
