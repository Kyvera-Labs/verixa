import { createConnection } from "node:net";

const CONNECT_TIMEOUT_MS = 2000;

/**
 * Resolves `true` if a plain TCP connection to `host:port` succeeds within
 * a short timeout, `false` otherwise. Deliberately protocol-agnostic (no
 * `pg` driver) — see `scripts/db-wait.mjs`, which uses the same primitive
 * for the same reason and is intentionally not shared code with this file:
 * one is a dependency-free root-level CLI script, the other is workspace
 * package test code, and duplicating ~15 lines is cheaper than an awkward
 * cross-boundary import between the two.
 */
export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(false);
    });
  });
}
