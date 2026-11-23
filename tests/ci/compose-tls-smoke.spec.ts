import { describe, expect, it } from "vitest";

import {
  assertSmokeResults,
  runTlsSmoke,
  tlsSmokeCommands,
} from "../../infra/ci/compose-tls-smoke.mjs";

const OPTIONS = {
  certDirectory: "infra/nginx/certs",
  httpPort: 18080,
  httpsPort: 18443,
};

function resolved(value: string): Promise<string> {
  return Promise.resolve(value);
}

describe("HTTPS edge smoke test (Issue 387 / #499)", () => {
  it("runs certificate generation, stack start, both probes and cleanup in order", () => {
    const commands = tlsSmokeCommands(OPTIONS).map((command) => command.name);
    expect(commands).toEqual([
      "generate-self-signed-certificate",
      "start-proxy-and-stub-api",
      "http-redirect",
      "tls-handshake-and-proxy-forwarding",
      "stop-smoke-stack",
    ]);
    const commandsWithArgs = tlsSmokeCommands(OPTIONS);
    expect(commandsWithArgs[2]!.argv).toContain("--write-out");
    expect(commandsWithArgs[3]!.argv).toContain("--cacert");
    expect(commandsWithArgs[3]!.argv).toContain("https://localhost:18443/health");
    expect(commandsWithArgs[4]!.argv).toContain("down");
  });

  it("requires an HTTPS redirect and a response forwarded by api", () => {
    expect(assertSmokeResults("301 https://localhost:18443/health", "ok\n")).toEqual({
      status: 301,
      redirect: "https://localhost:18443/health",
    });
    expect(() => assertSmokeResults("200 http://localhost:18080/health", "ok")).toThrow(
      /expected an HTTP to HTTPS redirect/,
    );
    expect(() => assertSmokeResults("301 http://localhost:18080/health", "ok")).toThrow(
      /redirect target is not HTTPS/,
    );
    expect(() => assertSmokeResults("301 https://localhost:18443/health", "stub failed")).toThrow(
      /proxy did not forward/,
    );
  });

  it("still tears the stack down when an assertion fails", async () => {
    const calls: string[][] = [];
    await expect(
      runTlsSmoke(OPTIONS, (argv) => {
        calls.push(argv);
        if (argv.includes("--write-out")) return resolved("200 http://localhost:18080/health");
        return resolved("ok");
      }),
    ).rejects.toThrow(/expected an HTTP to HTTPS redirect/);
    expect(calls).toHaveLength(5);
    expect(calls[4]).toContain("down");
  });

  it("returns probe results on a passing run", async () => {
    const results = (await runTlsSmoke(OPTIONS, (argv) => {
      if (argv.includes("--write-out")) return resolved("308 https://localhost:18443/health");
      if (argv.includes("--cacert")) return resolved("ok");
      return resolved("");
    })) as Record<string, string>;
    expect(results["http-redirect"]).toContain("https://");
    expect(results["tls-handshake-and-proxy-forwarding"]).toBe("ok");
  });
});
