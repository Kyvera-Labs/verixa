import { URL } from "node:url";

const stellarAnchorEntry = new URL(
  "../../../packages/stellar-anchor/dist/index.js",
  import.meta.url,
).href;

/** Resolve the injected workspace copy to its freshly-built workspace output. */
/** @type {import("node:module").Module.ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@verixa/stellar-anchor") {
    const result = await nextResolve(stellarAnchorEntry, context);
    return result;
  }
  const result = await nextResolve(specifier, context);
  return result;
}
