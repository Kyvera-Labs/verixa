import { Result } from "@verixa/shared-kernel";

/**
 * Unwraps a domain `Result` in a builder step, rethrowing the domain's own error when a transition
 * is refused, so tests can assert on `InvalidStatusTransitionError` or `ValidationError` exactly as
 * production callers see them. Unlike `unwrapResult`, it does not wrap the error.
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
