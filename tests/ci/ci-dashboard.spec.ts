import { describe, expect, it } from "vitest";

import { runCiDashboardGenerator } from "./helpers/ci-tooling.js";

describe("CI Dashboard Generator (Issue 379)", () => {
  it("executes the CI dashboard generator tool as a subprocess and asserts exitCode 0", () => {
    const result = runCiDashboardGenerator();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Pipeline health dashboard written");
    expect(result.stdout).toContain("Overall Pass Rate");
  });
});
