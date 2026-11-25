import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  analyzeCacheConfiguration,
  assertBuildTimings,
  dependencyFingerprint,
  stepStatus,
} from "../../infra/ci/docker-cache-check.mjs";

const REPO_ROOT = resolve(__dirname, "../..");
const DOCKERFILE = readFileSync(resolve(REPO_ROOT, "apps/api/Dockerfile"), "utf8");
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github/workflows/docker-publish.yml"), "utf8");

const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "verixa", dependencies: { fastify: "^5.0.0" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
  "apps/api/package.json": JSON.stringify({ name: "@verixa/api" }),
  "packages/database/package.json": JSON.stringify({ name: "@verixa/database" }),
  "packages/database/prisma/schema.prisma": "generator client {}\n",
  "apps/api/src/app.ts": "export const app = 1;\n",
};

describe("Docker layer cache configuration (Issue 384 / #496)", () => {
  it("accepts the repository's Dockerfile and publish workflow", () => {
    const plan = analyzeCacheConfiguration(DOCKERFILE, WORKFLOW);
    expect(plan.errors).toEqual([]);
    expect(DOCKERFILE).toMatch(/^# syntax=docker\/dockerfile:1\.20$/m);
    expect(plan.manifestPaths).toContain("pnpm-lock.yaml");
    expect(plan.manifestPaths).toContain("packages/*/tsconfig.json");
    expect(plan.cacheFrom.some((value: string) => value.includes("type=gha"))).toBe(true);
    expect(
      plan.cacheTo.some(
        (value: string) => value.includes("type=gha") && value.includes("mode=max"),
      ),
    ).toBe(true);
  });

  it("rejects a frontend that cannot parse COPY --parents", () => {
    const regressed = DOCKERFILE.replace("dockerfile:1.20", "dockerfile:1.9");
    const plan = analyzeCacheConfiguration(regressed, WORKFLOW);
    expect(plan.errors.join(" ")).toMatch(/dockerfile:1\.20\+/);
  });

  it("ignores source edits when fingerprinting the dependency layer inputs", () => {
    const before = dependencyFingerprint(FIXTURE_FILES, DOCKERFILE);
    const afterSourceEdit = dependencyFingerprint(
      { ...FIXTURE_FILES, "apps/api/src/app.ts": "export const app = 2;\n" },
      DOCKERFILE,
    );
    expect(afterSourceEdit).toBe(before);

    const afterManifestEdit = dependencyFingerprint(
      {
        ...FIXTURE_FILES,
        "package.json": JSON.stringify({ name: "verixa", dependencies: { fastify: "^6.0.0" } }),
      },
      DOCKERFILE,
    );
    expect(afterManifestEdit).not.toBe(before);
  });

  it("detects a regression that copies package source before install", () => {
    const regressed = DOCKERFILE.replace(/^COPY --parents.*$/m, "COPY packages packages");
    const plan = analyzeCacheConfiguration(regressed, WORKFLOW);
    expect(plan.copiesPackageSourcesIntoDeps).toBe(true);
    expect(plan.errors.join(" ")).toMatch(/must not COPY package sources/);

    const before = dependencyFingerprint(FIXTURE_FILES, regressed);
    const after = dependencyFingerprint(
      {
        ...FIXTURE_FILES,
        "packages/database/src/client.ts": "export const changed = true;\n",
      },
      regressed,
    );
    expect(after).not.toBe(before);
  });

  it("reads BuildKit's own cached/rebuilt verdict from plain progress logs", () => {
    const step = "pnpm install --frozen-lockfile";
    const cached = `#12 [deps 5/6] RUN --mount=type=cache ${step}\n#12 CACHED\n`;
    const rebuilt = `#12 [deps 5/6] RUN --mount=type=cache ${step}\n#12 DONE in 12s\n`;
    expect(stepStatus(cached, step)).toBe("CACHED");
    expect(stepStatus(rebuilt, step)).toBe("REBUILT");
    expect(() => stepStatus(cached, "pnpm deploy")).toThrow(/no step containing/);
  });

  it("fails when a warm build is not a fraction of the cold build", () => {
    expect(() =>
      assertBuildTimings({ coldSeconds: 100, warmSeconds: 70, sourceSeconds: 75 }),
    ).not.toThrow();
    expect(() =>
      assertBuildTimings({ coldSeconds: 38, warmSeconds: 0, sourceSeconds: 0 }),
    ).not.toThrow();
    expect(() =>
      assertBuildTimings({ coldSeconds: 100, warmSeconds: 95, sourceSeconds: 70 }),
    ).toThrow(/warm build/);
    expect(() =>
      assertBuildTimings({ coldSeconds: 100, warmSeconds: 70, sourceSeconds: 95 }),
    ).toThrow(/source-only build/);
  });
});
