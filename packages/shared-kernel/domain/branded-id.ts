import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

/**
 * Attaches a compile-time-only "brand" to a base type so that two values
 * with the same underlying representation (e.g. two UUID strings) are not
 * interchangeable unless they carry the same brand. Erased at runtime — the
 * `[brand]` property never actually exists on the value.
 */
export type Branded<T, Brand extends string> = T & { readonly [brand]: Brand };

/** A UUID string branded with a specific identifier kind, e.g. `Id<"UserId">`. */
export type Id<Brand extends string> = Branded<string, Brand>;

/** Generates a new random UUID, branded as the given identifier kind. */
export function createId<Brand extends string>(): Id<Brand> {
  return randomUUID() as Id<Brand>;
}

/**
 * Brands an already-known UUID string (e.g. one read back from a database
 * row) as the given identifier kind. Performs no format validation — only use
 * this on values that already came from `createId` or another trusted source.
 */
export function asId<Brand extends string>(value: string): Id<Brand> {
  return value as Id<Brand>;
}
