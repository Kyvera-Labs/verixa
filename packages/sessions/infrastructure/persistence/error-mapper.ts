import { PrismaClientKnownRequestError } from "@verixa/database";
import { ConflictError, NotFoundError } from "@verixa/shared-kernel";

/**
 * Translates Prisma errors into domain errors so use cases never depend on Prisma error codes.
 *
 * Only errors a caller can act on are mapped. Connection failures, timeouts and query errors are
 * rethrown unchanged for the top-level error boundary (see docs/guides/error-handling.md).
 */

/** Unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";
/** An operation (update/delete) targeted a row that does not exist. */
const RECORD_NOT_FOUND = "P2025";
/** Foreign key constraint violation. */
const FOREIGN_KEY_VIOLATION = "P2003";

function isKnownRequestError(error: unknown): error is PrismaClientKnownRequestError {
  return error instanceof PrismaClientKnownRequestError;
}

/**
 * The field(s) a unique violation was raised on, when Prisma reports them.
 *
 * Best-effort: `meta.target` is documented as loosely typed and varies by
 * database and Prisma version (string, array, or absent). Treated as a
 * diagnostic nicety rather than something to branch on — code that needed a
 * guaranteed field name would be relying on an implementation detail of the
 * driver.
 */
function violatedFields(error: PrismaClientKnownRequestError): string[] {
  const target: unknown = error.meta?.["target"];
  if (Array.isArray(target)) {
    return target.filter((value): value is string => typeof value === "string");
  }
  return typeof target === "string" ? [target] : [];
}

/**
 * Maps a Prisma error to a domain error, or rethrows if it has no domain
 * meaning.
 *
 * `entity` names the aggregate for the message — repositories know what they
 * persist, and a message reading "Session already exists" beats
 * "Unique constraint failed on the fields: (`id`)".
 */
export function mapPrismaError(error: unknown, entity: string): never {
  if (isKnownRequestError(error)) {
    switch (error.code) {
      case UNIQUE_VIOLATION: {
        const fields = violatedFields(error);
        const detail = fields.length > 0 ? ` (${fields.join(", ")})` : "";
        throw new ConflictError(`${entity} already exists with the same unique value${detail}.`);
      }

      case FOREIGN_KEY_VIOLATION: {
        // A reference to a row that isn't there. From the caller's side this
        // is indistinguishable from "the thing you referenced doesn't exist",
        // which is exactly NotFoundError — not a conflict, since nothing is
        // competing for the same key.
        throw new NotFoundError(
          `${entity} references a record that does not exist. A foreign key constraint failed.`,
        );
      }

      case RECORD_NOT_FOUND: {
        throw new NotFoundError(`${entity} was not found.`);
      }

      default:
        break;
    }
  }

  // Everything else keeps its original type and stack. Wrapping an
  // unrecognized failure in a domain error would claim it was expected and
  // bury what actually went wrong.
  throw error;
}

/**
 * Runs a repository operation, translating any Prisma error on the way out.
 *
 * ```ts
 * return withMappedErrors("Session", async () => {
 *   await this.prisma.session.create({ data: row });
 * });
 * ```
 */
export async function withMappedErrors<T>(entity: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return mapPrismaError(error, entity);
  }
}
