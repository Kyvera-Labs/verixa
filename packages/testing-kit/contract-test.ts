import { beforeEach, describe } from "vitest";

/** An adapter that claims to implement a port under test. */
export interface ContractImplementation<Port> {
  readonly name: string;
  readonly factory: () => Port | Promise<Port>;
}

/** Registers assertions shared by every implementation of a port. */
export type ContractSpec<Port> = (port: () => Port) => void;

/**
 * Run one Vitest contract suite against each implementation of a port.
 * A fresh instance is constructed before every test, keeping one assertion
 * from leaking state into the next and making adapter results comparable.
 */
export function defineContractTests<Port>(
  implementations: readonly ContractImplementation<Port>[],
  spec: ContractSpec<Port>,
): void {
  if (implementations.length === 0) {
    throw new Error("defineContractTests requires at least one implementation");
  }

  // Validate every name before registering any suite, so a bad list fails as a
  // whole instead of leaving the earlier implementations' suites registered.
  const names = new Set<string>();
  for (const implementation of implementations) {
    if (implementation.name.trim() === "") {
      throw new Error("Contract implementation names must not be empty");
    }
    if (names.has(implementation.name)) {
      throw new Error(`Duplicate contract implementation name: ${implementation.name}`);
    }
    names.add(implementation.name);
  }

  for (const implementation of implementations) {
    describe(`${implementation.name} contract`, () => {
      let current: Port | undefined;
      beforeEach(async () => {
        current = await implementation.factory();
      });
      spec(() => {
        if (current === undefined) {
          throw new Error(`${implementation.name} contract port used before its factory ran`);
        }
        return current;
      });
    });
  }
}
