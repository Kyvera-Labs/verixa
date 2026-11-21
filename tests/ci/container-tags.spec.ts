import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sha = "1234567890abcdef1234567890abcdef12345678";
const script = fileURLToPath(new URL("../../infra/ci/container-tags.mjs", import.meta.url));

function run(eventName: string, ref: string, commit: string): string[] {
  return execFileSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, GITHUB_SHA: commit },
  })
    .trim()
    .split("\n");
}

describe("containerTags", () => {
  it("publishes an immutable commit reference and latest on main", () => {
    expect(run("push", "refs/heads/main", sha)).toEqual(["sha-1234567", "latest"]);
  });

  it("publishes commit, semver, and latest tags for a release", () => {
    expect(run("push", "refs/tags/v2.4.1", sha)).toEqual(["sha-1234567", "v2.4.1", "latest"]);
  });

  it("computes non-publishing tags for pull requests", () => {
    expect(run("pull_request", "refs/pull/585/merge", sha)).toEqual(["sha-1234567", "pr-585"]);
  });

  it("rejects non-release tags and malformed commit identifiers", () => {
    expect(() => run("push", "refs/tags/v2-beta", sha)).toThrow(
      "Unsupported container publish event",
    );
    expect(() => run("push", "refs/heads/main", "short")).toThrow("full 40-character");
  });
});
