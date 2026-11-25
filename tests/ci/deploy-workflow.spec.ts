import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

const smokeTestScript = fileURLToPath(
  new URL("../../infra/ci/deploy-smoke-test.mjs", import.meta.url),
);
const deployWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
);
const productionEnvPath = fileURLToPath(
  new URL("../../.github/environments/production.yml", import.meta.url),
);

interface SmokeServer {
  url: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<SmokeServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("deploy-smoke-test.mjs", () => {
  const activeServers: SmokeServer[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const server = activeServers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it("passes when /health returns 200 and /version matches the expected tag", async () => {
    const server = await startMockServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "v1.4.0" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(server);

    const { stdout } = await execFileAsync(process.execPath, [
      smokeTestScript,
      "--url",
      server.url,
      "--expected-version",
      "v1.4.0",
      "--retries",
      "3",
      "--interval-ms",
      "10",
    ]);

    expect(stdout).toContain("Smoke test passed");
    expect(stdout).toContain("v1.4.0");
  });

  it("retries until /health becomes 200", async () => {
    let healthCalls = 0;
    const server = await startMockServer((req, res) => {
      if (req.url === "/health") {
        healthCalls += 1;
        if (healthCalls < 3) {
          res.writeHead(503);
          res.end("starting");
          return;
        }
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(server);

    const { stdout } = await execFileAsync(process.execPath, [
      smokeTestScript,
      "--url",
      server.url,
      "--retries",
      "5",
      "--interval-ms",
      "10",
    ]);

    expect(healthCalls).toBe(3);
    expect(stdout).toContain("after 3 attempt(s)");
  });

  it("fails when /health is 200 but /version serves an older release", async () => {
    const server = await startMockServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (req.url === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "v1.3.0" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(server);

    await expect(
      execFileAsync(process.execPath, [
        smokeTestScript,
        "--url",
        server.url,
        "--expected-version",
        "v1.4.0",
        "--retries",
        "2",
        "--interval-ms",
        "10",
      ]),
    ).rejects.toThrow(/Version mismatch/);
  });

  it("fails when /health never becomes healthy within the retry budget", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(503);
      res.end("unhealthy");
    });
    activeServers.push(server);

    await expect(
      execFileAsync(process.execPath, [
        smokeTestScript,
        "--url",
        server.url,
        "--retries",
        "2",
        "--interval-ms",
        "10",
      ]),
    ).rejects.toThrow(/Smoke test failed after 2 attempt/);
  });

  it("rejects invalid or non-HTTP URLs", async () => {
    await expect(
      execFileAsync(process.execPath, [smokeTestScript, "--url", "ftp://example.com"]),
    ).rejects.toThrow(/Unsupported URL protocol/);
  });
});

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
}

interface WorkflowJob {
  needs?: string[];
  environment?: { name: string; url?: string };
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps: WorkflowStep[];
}

interface DeployWorkflow {
  name: string;
  on: {
    workflow_run: { workflows: string[]; types: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, WorkflowJob>;
}

interface ProductionEnvironmentSpec {
  name: string;
  protection_rules: {
    required_reviewers: {
      teams: string[];
      prevent_self_review: boolean;
    };
    wait_timer: number;
    deployment_branch_policy: {
      allowed_patterns: string[];
    };
  };
}

describe("deploy workflow and production environment specification", () => {
  const workflow = parseYaml(readFileSync(deployWorkflowPath, "utf8")) as DeployWorkflow;
  const prodEnv = parseYaml(readFileSync(productionEnvPath, "utf8")) as ProductionEnvironmentSpec;

  it("triggers on completed Release runs and supports manual dispatch", () => {
    expect(workflow.name).toBe("Deploy");
    expect(workflow.on.workflow_run.workflows).toContain("Release");
    expect(workflow.on.workflow_run.types).toContain("completed");
    expect(workflow.on.workflow_dispatch.inputs).toHaveProperty("image_tag");
  });

  it("never cancels in-flight deployments", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs["deploy-staging"]?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs["deploy-production"]?.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("auto-deploys to staging with a post-deploy smoke test and failure rollback", () => {
    const staging = workflow.jobs["deploy-staging"];
    expect(staging).toBeDefined();
    expect(staging?.environment?.name).toBe("staging");
    expect(staging?.needs).toContain("resolve-release");

    const smokeStep = staging?.steps.find((s) => s.id === "smoke_test");
    expect(smokeStep?.run).toContain("deploy-smoke-test.mjs");

    const rollbackStep = staging?.steps.find((s) =>
      s.name?.toLowerCase().includes("roll back staging"),
    );
    expect(rollbackStep?.if).toContain("failure()");
    expect(rollbackStep?.if).toContain("steps.smoke_test.outcome == 'failure'");
  });

  it("gates production promotion behind staging success and the production environment", () => {
    const production = workflow.jobs["deploy-production"];
    expect(production).toBeDefined();
    expect(production?.environment?.name).toBe("production");
    expect(production?.needs).toEqual(
      expect.arrayContaining(["resolve-release", "deploy-staging"]),
    );

    const smokeStep = production?.steps.find((s) => s.id === "smoke_test");
    expect(smokeStep?.run).toContain("deploy-smoke-test.mjs");

    const rollbackStep = production?.steps.find((s) =>
      s.name?.toLowerCase().includes("roll back production"),
    );
    expect(rollbackStep?.if).toContain("failure()");
    expect(rollbackStep?.if).toContain("steps.smoke_test.outcome == 'failure'");
  });

  it("enforces required reviewers and branch/tag restrictions in production.yml", () => {
    expect(prodEnv.name).toBe("production");
    expect(prodEnv.protection_rules.required_reviewers.teams.length).toBeGreaterThan(0);
    expect(prodEnv.protection_rules.required_reviewers.prevent_self_review).toBe(true);
    expect(prodEnv.protection_rules.deployment_branch_policy.allowed_patterns).toEqual(
      expect.arrayContaining(["main", "v*.*.*"]),
    );
  });
});
