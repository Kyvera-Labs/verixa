import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compareMetricSet,
  compareCoverage,
  updateBaselineMetrics,
  formatRatchetMarkdown,
  normalizeCoverageSummary,
  type CoverageBaseline,
} from "../../infra/ci/coverage-ratchet.js";

describe("coverage-ratchet (Issue 413)", () => {
  const sampleBaseline: CoverageBaseline = {
    version: 1,
    updatedAt: "2026-11-19T00:00:00.000Z",
    tolerance: 0.1,
    aggregate: {
      lines: 85.0,
      statements: 85.0,
      functions: 80.0,
      branches: 75.0,
    },
    packages: {
      "@verixa/identity": {
        lines: 90.0,
        statements: 90.0,
        functions: 85.0,
        branches: 85.0,
      },
      "@verixa/sessions": {
        lines: 90.0,
        statements: 90.0,
        functions: 85.0,
        branches: 85.0,
      },
    },
  };

  describe("compareMetricSet", () => {
    it("classifies as improved when values increase", () => {
      const current = { lines: 87.5, statements: 86.0, functions: 82.0, branches: 78.0 };
      const baseline = { lines: 85.0, statements: 85.0, functions: 80.0, branches: 75.0 };

      const res = compareMetricSet("test-target", current, baseline, 0.1);

      expect(res.status).toBe("improved");
      expect(res.metrics.every((m) => m.status === "improved")).toBe(true);
      expect(res.metrics.find((m) => m.metric === "lines")?.delta).toBe(2.5);
    });

    it("classifies as maintained when drop is within tolerance", () => {
      // 84.95 vs 85.0 -> -0.05 drop, tolerance is 0.1
      const current = { lines: 84.95, statements: 85.0, functions: 80.0, branches: 75.0 };
      const baseline = { lines: 85.0, statements: 85.0, functions: 80.0, branches: 75.0 };

      const res = compareMetricSet("test-target", current, baseline, 0.1);

      expect(res.status).toBe("maintained");
      const lineMetric = res.metrics.find((m) => m.metric === "lines");
      expect(lineMetric?.status).toBe("maintained");
      expect(lineMetric?.delta).toBe(-0.05);
    });

    it("classifies as regressed when drop exceeds tolerance", () => {
      // 84.8 vs 85.0 -> -0.20 drop, tolerance is 0.1
      const current = { lines: 84.8, statements: 85.0, functions: 80.0, branches: 75.0 };
      const baseline = { lines: 85.0, statements: 85.0, functions: 80.0, branches: 75.0 };

      const res = compareMetricSet("test-target", current, baseline, 0.1);

      expect(res.status).toBe("regressed");
      const lineMetric = res.metrics.find((m) => m.metric === "lines");
      expect(lineMetric?.status).toBe("regressed");
      expect(lineMetric?.delta).toBe(-0.2);
    });
  });

  describe("compareCoverage", () => {
    it("passes when all packages and aggregate meet or exceed baseline", () => {
      const summary = {
        total: { lines: 86.0, statements: 86.0, functions: 81.0, branches: 76.0 },
        packages: {
          "@verixa/identity": { lines: 91.0, statements: 91.0, functions: 86.0, branches: 86.0 },
          "@verixa/sessions": { lines: 90.0, statements: 90.0, functions: 85.0, branches: 85.0 },
        },
      };

      const result = compareCoverage(summary, sampleBaseline, { tolerance: 0.1 });

      expect(result.passed).toBe(true);
      expect(result.hasRegressions).toBe(false);
      expect(result.regressions).toHaveLength(0);
      expect(result.aggregate.status).toBe("improved");
    });

    it("fails when any package regresses beyond tolerance", () => {
      const summary = {
        total: { lines: 85.0, statements: 85.0, functions: 80.0, branches: 75.0 },
        packages: {
          "@verixa/identity": { lines: 88.0, statements: 90.0, functions: 85.0, branches: 85.0 }, // -2.0 lines drop
          "@verixa/sessions": { lines: 90.0, statements: 90.0, functions: 85.0, branches: 85.0 },
        },
      };

      const result = compareCoverage(summary, sampleBaseline, { tolerance: 0.1 });

      expect(result.passed).toBe(false);
      expect(result.hasRegressions).toBe(true);
      expect(result.regressions).toHaveLength(1);
      expect(result.regressions[0]?.target).toBe("@verixa/identity");
    });

    it("passes with overrideApplied when allowDrop is enabled", () => {
      const summary = {
        total: { lines: 80.0, statements: 80.0, functions: 75.0, branches: 70.0 }, // regressed
        packages: {
          "@verixa/identity": { lines: 85.0, statements: 85.0, functions: 80.0, branches: 80.0 }, // regressed
          "@verixa/sessions": { lines: 90.0, statements: 90.0, functions: 85.0, branches: 85.0 },
        },
      };

      const result = compareCoverage(summary, sampleBaseline, {
        tolerance: 0.1,
        allowDrop: true,
        overrideReason: "Refactoring auth token payload schema",
      });

      expect(result.passed).toBe(true);
      expect(result.hasRegressions).toBe(true);
      expect(result.overrideApplied).toBe(true);
      expect(result.overrideReason).toBe("Refactoring auth token payload schema");
    });
  });

  describe("updateBaselineMetrics", () => {
    it("updates only metrics that improved", () => {
      const summary = {
        total: { lines: 88.0, statements: 84.0, functions: 82.0, branches: 74.0 }, // lines/functions improved, statements/branches lower
        packages: {
          "@verixa/identity": { lines: 92.0, statements: 90.0, functions: 85.0, branches: 85.0 },
          "@verixa/sessions": { lines: 89.0, statements: 90.0, functions: 85.0, branches: 85.0 },
        },
      };

      const updated = updateBaselineMetrics(sampleBaseline, summary, false);

      expect(updated.aggregate.lines).toBe(88.0); // improved from 85
      expect(updated.aggregate.statements).toBe(85.0); // kept at 85
      expect(updated.aggregate.functions).toBe(82.0); // improved from 80
      expect(updated.aggregate.branches).toBe(75.0); // kept at 75

      expect(updated.packages["@verixa/identity"]?.lines).toBe(92.0);
      expect(updated.packages["@verixa/sessions"]?.lines).toBe(90.0);
    });

    it("updates all metrics when force is true", () => {
      const summary = {
        total: { lines: 80.0, statements: 80.0, functions: 75.0, branches: 70.0 },
        packages: {},
      };

      const updated = updateBaselineMetrics(sampleBaseline, summary, true);

      expect(updated.aggregate.lines).toBe(80.0);
      expect(updated.aggregate.statements).toBe(80.0);
    });
  });

  describe("formatRatchetMarkdown", () => {
    it("formats markdown table and success message", () => {
      const summary = {
        total: { lines: 86.0, statements: 86.0, functions: 81.0, branches: 76.0 },
        packages: {
          "@verixa/identity": { lines: 91.0, statements: 91.0, functions: 86.0, branches: 86.0 },
          "@verixa/sessions": { lines: 90.0, statements: 90.0, functions: 85.0, branches: 85.0 },
        },
      };

      const result = compareCoverage(summary, sampleBaseline, { tolerance: 0.1 });
      const md = formatRatchetMarkdown(result);

      expect(md).toContain("## Coverage Ratchet Summary (Issue 413)");
      expect(md).toContain("**All coverage ratchet gates satisfied.**");
      expect(md).toContain("| **workspace (aggregate)** |");
      expect(md).toContain("| **@verixa/identity** |");
    });

    it("formats regression message and required actions when gate fails", () => {
      const summary = {
        total: { lines: 80.0, statements: 80.0, functions: 75.0, branches: 70.0 },
        packages: {},
      };

      const result = compareCoverage(summary, sampleBaseline, { tolerance: 0.1 });
      const md = formatRatchetMarkdown(result);

      expect(md).toContain("**Coverage ratchet check failed.**");
      expect(md).toContain("### Required Action");
      expect(md).toContain("COVERAGE_RATCHET_OVERRIDE");
    });
  });
});

describe("normalizeCoverageSummary", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const pct = (value: number) => ({ total: 10, covered: value / 10, skipped: 0, pct: value });
  const metrics = (value: number) => ({
    lines: pct(value),
    statements: pct(value),
    functions: pct(value),
    branches: pct(value),
  });

  it("reads the summary coverage-merge writes: aggregate totals and directory keys", () => {
    // The shape infra/ci/coverage-merge.ts produces. Before normalising, the
    // ratchet looked for `total` and for package names, found neither, and
    // scored every target 0%.
    const merged = {
      aggregate: metrics(83.65),
      packages: { "packages/audit": metrics(93.93), "packages/config": metrics(98) },
    };

    const summary = normalizeCoverageSummary(merged, repoRoot);

    expect(summary.total).toEqual(merged.aggregate);
    expect(Object.keys(summary.packages ?? {}).sort()).toEqual(["@verixa/audit", "@verixa/config"]);

    const result = compareCoverage(summary, {
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
      tolerance: 0.1,
      aggregate: { lines: 83.6, statements: 83.6, functions: 83.6, branches: 83.6 },
      packages: {
        "@verixa/audit": { lines: 93.9, statements: 93.9, functions: 93.9, branches: 93.9 },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.packages[0]?.metrics.find((m) => m.metric === "lines")?.current).toBe(93.93);
  });

  it("keeps keys that are already package names, or have no manifest", () => {
    const summary = normalizeCoverageSummary(
      {
        total: metrics(80),
        packages: { "@verixa/x": metrics(1), "tests/integration": metrics(2) },
      },
      repoRoot,
    );

    expect(Object.keys(summary.packages ?? {}).sort()).toEqual(["@verixa/x", "tests/integration"]);
  });
});
