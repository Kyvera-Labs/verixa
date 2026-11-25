import { Result } from "@verixa/shared-kernel";

/**
 * Unwraps a domain `Result` inside a builder step, rethrowing the domain's own
 * error object when the transition was refused.
 *
 * Deliberately not `unwrapResult` from `../factories`: that helper wraps the
 * error in a generic `Error` with a JSON message, which is fine for a factory
 * default that should never fail, but a builder exists to express
 * preconditions — when a chain describes an impossible history, the test
 * should be able to assert on `InvalidStatusTransitionError` /
 * `ValidationError` exactly as production callers would see it.
 */
export function orThrowDomainError<T, E>(result: Result<T, E>): T {
  if (Result.isOk(result)) {
    return result.value;
  }
  // The error type is the domain's (an `Error` subclass in every context);
  // anything else is still thrown as-is rather than re-wrapped.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw result.error;
}
