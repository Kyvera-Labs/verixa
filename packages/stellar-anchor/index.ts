// Curated public surface of @verixa/stellar-anchor. See
// docs/guides/stellar-anchoring.md and docs/adr/0003-stellar-audit-anchoring.md.

// The port and its types — what consumers depend on. Nothing here mentions
// Stellar, so a consumer can be written (and tested) against anchoring in
// general, then wired to a specific ledger at composition time.
export { AnchorError, isValidSha256Hex } from "./application/ports/hash-anchor.js";
export type { AnchorReceipt, HashAnchor } from "./application/ports/hash-anchor.js";

// The Stellar adapter.
export { StellarHashAnchor } from "./infrastructure/stellar/stellar-hash-anchor.js";
export type {
  StellarHashAnchorOptions,
  StellarNetwork,
} from "./infrastructure/stellar/stellar-hash-anchor.js";

// Test double, exported deliberately: consumers testing their own anchoring
// logic need it, and it doubles as the "anchoring disabled" implementation
// for deployments that want no ledger dependency at all.
export { InMemoryHashAnchor } from "./infrastructure/testing/in-memory-hash-anchor.js";

// The shared behavioral contract, exported so any future HashAnchor
// implementation can prove it behaves identically rather than merely
// compiling against the same interface.
export { hashAnchorContract } from "./infrastructure/testing/contracts/hash-anchor.contract.js";
