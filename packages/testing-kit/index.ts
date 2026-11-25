// Curated public API of @verixa/testing-kit: the port contract-test harness,
// standardized fixture factories (Object Mother pattern) and in-memory fakes.

export { defineContractTests } from "./contract-test.js";
export type { ContractImplementation, ContractSpec } from "./contract-test.js";
export * from "./factories/index.js";
export * from "./fakes/index.js";
export { FixedClock } from "./fixed-clock.js";
export type { Clock } from "./fixed-clock.js";
export { SeededRandom } from "./seeded-random.js";
