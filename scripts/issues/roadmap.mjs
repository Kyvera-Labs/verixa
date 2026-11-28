/**
 * Parses `planning/issues/phase-*.md` into structured issue records.
 *
 * The roadmap is the single source of truth for what Verixa is going to be,
 * and it is written for humans first — prose, not YAML. Parsing it rather
 * than maintaining a parallel machine-readable copy means the two can never
 * disagree, which they would within a week.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const ISSUES_DIR = join(REPO_ROOT, "planning", "issues");

/** Fields each issue block carries, in the order the roadmap writes them. */
const FIELDS = {
  Description: "description",
  Objective: "objective",
  "Acceptance Criteria": "acceptanceCriteria",
  Dependencies: "dependencies",
  "Estimated Complexity": "complexity",
  "Files Affected": "filesAffected",
  "Tests Required": "testsRequired",
  "Documentation Required": "documentationRequired",
  "Educational Notes": "educationalNotes",
  Deliverables: "deliverables",
};

/**
 * Splits a `**Field:** value` block into its parts.
 *
 * Values run to the next `**Field:**` rather than to the next newline,
 * because several roadmap entries wrap across lines and truncating at the
 * first newline silently drops half the acceptance criteria — the exact
 * field a contributor most needs intact.
 */
function parseFields(block) {
  const result = {};
  const pattern = /\*\*([^*]+):\*\*\s*([\s\S]*?)(?=\n\*\*[^*]+:\*\*|\n---|\s*$)/g;

  let match;
  while ((match = pattern.exec(block)) !== null) {
    const key = FIELDS[match[1].trim()];
    if (key) result[key] = match[2].trim().replace(/\s*\n\s*/g, " ");
  }
  return result;
}

/** Splits a comma/space separated dependency list into roadmap ids. */
function parseDependencies(raw) {
  if (!raw || /^(none|n\/a|-)$/i.test(raw.trim())) return [];
  return [...raw.matchAll(/\d{3}[A-D]?/g)].map((m) => m[0]);
}

/** Reads every phase file and returns a flat, ordered list of issues. */
export async function loadRoadmap() {
  const files = (await readdir(ISSUES_DIR)).filter((f) => /^phase-\d+.*\.md$/.test(f)).sort();

  const issues = [];
  const phases = new Map();

  for (const file of files) {
    const text = await readFile(join(ISSUES_DIR, file), "utf8");

    // The phase header: "# Phase 05 — Auth: Sessions & Tokens"
    // followed by a paragraph of context that is genuinely useful to a
    // contributor and would otherwise be thrown away.
    const headerMatch = /^#\s*Phase\s*(\d+)\s*[—-]\s*(.+?)\s*\(Issues[^)]*\)/m.exec(text);
    if (!headerMatch) continue;

    const phaseNumber = headerMatch[1].padStart(2, "0");
    const phaseTitle = headerMatch[2].trim();
    const contextMatch = /\(Issues[^)]*\)\s*\n+([\s\S]*?)\n\s*---/.exec(text);

    phases.set(phaseNumber, {
      number: phaseNumber,
      title: phaseTitle,
      context: contextMatch ? contextMatch[1].trim().replace(/\s*\n\s*/g, " ") : "",
      file: `planning/issues/${file}`,
    });

    const blocks = text.split(/^### Issue /m).slice(1);
    for (const block of blocks) {
      const titleMatch = /^(\d{3}[A-D]?)\s*[—-]\s*(.+)/.exec(block);
      if (!titleMatch) continue;

      const fields = parseFields(block);
      issues.push({
        id: titleMatch[1],
        title: titleMatch[2].trim().replace(/\s+$/, ""),
        phase: phaseNumber,
        ...fields,
        dependencies: parseDependencies(fields.dependencies),
      });
    }
  }

  return { issues, phases };
}

/** Sorts by roadmap id, keeping suffixed ids (190A) immediately after their base. */
export function byRoadmapId(a, b) {
  const base = (id) => Number.parseInt(id.slice(0, 3), 10);
  const suffix = (id) => id.slice(3);
  return base(a.id) - base(b.id) || suffix(a.id).localeCompare(suffix(b.id));
}
