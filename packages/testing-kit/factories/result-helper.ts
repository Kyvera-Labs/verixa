import { Result } from "@verixa/shared-kernel";

export function unwrapResult<T, E>(result: Result<T, E>): T {
  if (Result.isOk(result)) {
    return result.value;
  }
  throw new Error(`Failed to unwrap Result: ${JSON.stringify(result.error)}`);
}
