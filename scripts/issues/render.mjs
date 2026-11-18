/**
 * Renders a parsed roadmap entry into a GitHub issue body.
 *
 * ## What this is optimising for
 *
 * A contributor who has never seen this codebase should be able to open one
 * issue and start work without asking a question first. That is the bar, and
 * it is a higher bar than "the task is described".
 *
 * Concretely, every issue answers four things the roadmap alone does not:
 *
 * 1. **Where does this sit?** — the phase context, and what already exists
 *    that this builds on.
 * 2. **What should I copy?** — a real file in the repository that solves the
 *    same shape of problem. This codebase is deliberately repetitive, so
 *    there is almost always a pattern to follow, and pointing at it converts
 *    a blank page into a diff.
 * 3. **When am I done?** — a checklist, not a paragraph.
 * 4. **What should I NOT do?** — scope boundaries, which is the section that
 *    prevents the 900-line pull request nobody can review.
 *
 * ## What this deliberately does not do
 *
 * It does not pad. The long exploratory format that suits an integration
 * spike — where the central question is "does this even work" — would be
 * noise on "add a use case following the existing pattern". Length here
 * tracks genuine uncertainty, and most of these issues are not uncertain.
 */

/** Which package a file path belongs to, used to pick the right exemplars. */
function packageOf(filesAffected) {
  const match = /packages\/([a-z-]+)/.exec(filesAffected ?? "");
  if (match) return match[1];
  if (/apps\/api/.test(filesAffected ?? "")) return "api";
  if (/^tests\//m.test(filesAffected ?? "")) return "tests";
  return null;
}

/** Which architectural layer, inferred from the paths the issue touches. */
function layerOf(filesAffected = "") {
  if (/domain\/entities/.test(filesAffected)) return "domain-entity";
  if (/domain\/value-objects/.test(filesAffected)) return "domain-value-object";
  if (/application\/ports/.test(filesAffected)) return "port";
  if (/application\/use-cases/.test(filesAffected)) return "use-case";
  if (/infrastructure\/persistence/.test(filesAffected)) return "adapter";
  if (/infrastructure/.test(filesAffected)) return "infrastructure";
  if (/routes|apps\/api/.test(filesAffected)) return "http";
  if (/\.github|Dockerfile|docker-compose|scripts\//.test(filesAffected)) return "ops";
  if (/docs\//.test(filesAffected)) return "docs";
  if (/^tests\/|integration/.test(filesAffected)) return "tests";
  return "general";
}

/**
 * Real files in this repository that already solve the same shape of problem.
 *
 * Every path here is verified to exist. A broken pointer is worse than no
 * pointer: it costs the contributor the time to discover it is broken and
 * then the confidence that anything else in the issue is accurate.
 */
const EXEMPLARS = {
  "domain-entity": [
    ["packages/identity/domain/entities/user.ts", "state transitions, invariants, domain events"],
    ["packages/audit/domain/entities/audit-log-entry.ts", "hashing, canonical form, no-setters"],
  ],
  "domain-value-object": [
    [
      "packages/identity/domain/value-objects/email.ts",
      "validation returning Result, normalisation",
    ],
    [
      "packages/credentials/domain/value-objects/raw-password.ts",
      "a value object that must never leak — redaction across every serialisation path",
    ],
  ],
  port: [
    [
      "packages/identity/application/ports/user-repository.ts",
      "method contracts documented in prose",
    ],
    [
      "packages/stellar-anchor/application/ports/hash-anchor.ts",
      "a port with no mention of its adapter",
    ],
  ],
  "use-case": [
    ["packages/identity/application/use-cases/register-user.ts", "the simplest complete example"],
    [
      "packages/credentials/application/use-cases/authenticate-with-password.ts",
      "a harder one: transaction boundaries, disclosure rules, failure paths",
    ],
  ],
  adapter: [
    [
      "packages/identity/infrastructure/persistence/prisma-user-repository.ts",
      "mapper + repository",
    ],
    [
      "packages/identity/infrastructure/testing/contracts/",
      "the contract suite every adapter must pass",
    ],
  ],
  infrastructure: [
    [
      "packages/credentials/infrastructure/argon2-password-hasher.ts",
      "wrapping a third-party library behind a port",
    ],
    [
      "packages/stellar-anchor/infrastructure/stellar/stellar-hash-anchor.ts",
      "an external-network adapter",
    ],
  ],
  http: [
    ["apps/api/src/routes/auth.ts", "schema validation, error mapping, no business logic"],
    ["apps/api/src/composition-root.ts", "where concrete implementations get wired"],
  ],
  tests: [
    ["tests/integration/auth-login-route.spec.ts", "real HTTP against a real database"],
    [
      "packages/credentials/application/use-cases/password-reset.spec.ts",
      "use case against in-memory fakes",
    ],
  ],
  ops: [[".github/workflows/ci.yml", "the existing pipeline and its comments"]],
  docs: [["docs/security/authentication-flows.md", "depth and tone expected of a docs change"]],
  general: [["packages/identity/", "the most complete package — follow its structure"]],
};

/** Layer-specific guidance that is genuinely different per layer. */
const LAYER_NOTES = {
  "domain-entity":
    "This is domain code, so it must not import anything from `infrastructure/`, Prisma, Fastify, or any library that talks to the outside world. If you find yourself needing one, the thing you actually need is a port.",
  "domain-value-object":
    "Value objects validate on construction and are immutable afterwards. Use a `Result` return rather than throwing — invalid input is an expected outcome here, not an exceptional one.",
  port: "A port is an interface plus the prose that says what implementations must guarantee. Write the contract comments as carefully as the signatures; they are what makes two adapters actually interchangeable.",
  "use-case":
    "Use cases orchestrate and do not contain business rules — those live in the domain. Keep expensive work (hashing, network calls) outside transaction boundaries, and return `Result` rather than throwing for expected failures.",
  adapter:
    "Adapters are the only place Prisma types may appear. Every repository adapter must pass the shared contract suite, which is what keeps the in-memory fake and the real database honest about behaving identically.",
  infrastructure:
    "Wrap the third-party library completely. Nothing above this layer should be able to tell which library you chose, which is what makes replacing it later a one-file change.",
  http: "Route handlers translate HTTP to a use case and back. No business logic, no repository access, no Prisma. Validate shape with JSON Schema; let the domain enforce rules.",
  tests:
    "Prefer testing behaviour over implementation. Database-backed tests skip themselves when no Postgres is reachable, so `pnpm test` still passes on a fresh clone without Docker.",
  ops: "Changes here affect every contributor. Explain the why in comments — the existing workflow files are written that way deliberately.",
  docs: "Documentation in this repo explains reasoning, not just mechanics. A paragraph on why a decision was made is worth more than three describing what the code does.",
  general:
    "Follow the structure of `packages/identity`, which is the most complete example in the repository.",
};

const COMPLEXITY = {
  S: { label: "Small", hint: "A focused change — typically one or two files plus tests." },
  M: { label: "Medium", hint: "Several files, or one file with real design decisions in it." },
  L: {
    label: "Large",
    hint: "Multiple files across layers. Consider posting your plan on the issue before writing much code.",
  },
  XL: {
    label: "Extra large",
    hint: "Substantial. Please comment with an approach before starting so we can agree on scope.",
  },
};

/** Splits a prose acceptance-criteria field into checklist items. */
function toChecklist(prose) {
  if (!prose) return [];
  return prose
    .split(/;\s*|\.\s+(?=[A-Z`])/)
    .map((part) => part.trim().replace(/\.$/, ""))
    .filter((part) => part.length > 3)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
}

/** Splits a comma-separated backtick-quoted file list into individual paths. */
function toFileList(prose) {
  if (!prose) return [];
  const quoted = [...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return quoted.length > 0 ? quoted : [prose];
}

/**
 * Renders one issue body.
 *
 * `issueNumbers` maps roadmap ids to GitHub issue numbers for dependencies
 * that have already been pushed, so a contributor can click straight through
 * to the work this builds on.
 */
export function renderIssueBody(issue, phase, issueNumbers = {}) {
  const layer = layerOf(issue.filesAffected);
  const pkg = packageOf(issue.filesAffected);
  const complexity = COMPLEXITY[issue.complexity] ?? COMPLEXITY.M;
  const exemplars = EXEMPLARS[layer] ?? EXEMPLARS.general;
  const checklist = toChecklist(issue.acceptanceCriteria);
  const files = toFileList(issue.filesAffected);

  const deps = issue.dependencies.map((id) => {
    const number = issueNumbers[id];
    return number ? `#${number} (roadmap ${id})` : `roadmap issue ${id}`;
  });

  const out = [];

  out.push(`## Summary\n\n${issue.description}\n`);

  out.push(
    `## Context\n\nThis is **Phase ${phase.number} — ${phase.title}**, issue \`${issue.id}\` of the [Verixa roadmap](../blob/main/planning/ROADMAP.md).\n`,
  );
  if (phase.context) out.push(`${phase.context}\n`);
  out.push(
    `Verixa is open-source infrastructure for authentication, authorization, identity, verification and audit logging, built to be production-grade *and* readable end to end. The codebase is deliberately repetitive: there is almost always an existing file solving the same shape of problem, and copying it is encouraged rather than frowned on.\n`,
  );

  out.push(`## Objective\n\n${issue.objective}\n`);

  if (deps.length > 0) {
    out.push(
      `## Dependencies\n\nThis builds on: ${deps.join(", ")}.\n\nIf any of those are still open, check with a maintainer on this issue before starting — you may be able to proceed against the interface alone, or it may be worth waiting.\n`,
    );
  } else {
    out.push(`## Dependencies\n\nNone. This can be picked up immediately.\n`);
  }

  out.push(
    `## Where to start\n\n${LAYER_NOTES[layer]}\n\nRead these first — they solve the same shape of problem and establish the conventions your change should follow:\n\n${exemplars
      .map(([path, why]) => `- [\`${path}\`](../blob/main/${path}) — ${why}`)
      .join("\n")}\n`,
  );

  out.push(
    `## Files you will likely touch\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n\nPaths are a guide, not a constraint. If the work genuinely belongs somewhere else, say so on the issue — a comment explaining why is a perfectly good contribution on its own.\n`,
  );

  out.push(
    `## Acceptance criteria\n\n${
      checklist.length > 0
        ? checklist.map((item) => `- [ ] ${item}`).join("\n")
        : `- [ ] ${issue.acceptanceCriteria}`
    }\n`,
  );

  out.push(
    `## Testing requirements\n\n${issue.testsRequired}\n\nThe full suite must pass (\`pnpm test\`), and new code needs tests that would fail without it. Tests asserting that code was written, rather than that it behaves correctly, will be sent back.\n`,
  );

  if (issue.documentationRequired && !/^none$/i.test(issue.documentationRequired)) {
    out.push(
      `## Documentation requirements\n\n${issue.documentationRequired}\n\nDocs here explain *why*, not just *what*. If you made a judgement call, write down the alternative you rejected and the reason — that is the most valuable sentence in most of our docs.\n`,
    );
  }

  if (issue.educationalNotes) {
    out.push(
      `## Why this is interesting\n\n${issue.educationalNotes}\n\nVerixa doubles as a teaching codebase, so this context is part of the deliverable rather than decoration. If you learn something while implementing it that is not written down here, please add it.\n`,
    );
  }

  out.push(
    `## Out of scope\n\nKeep the change focused on the deliverable below. Specifically, do **not** include in this pull request:\n\n- Refactors of unrelated code, however tempting\n- Reformatting files you did not otherwise change\n- Dependency upgrades not required by this issue\n- Work belonging to other roadmap issues, even adjacent ones\n\nIf you spot something worth fixing, open a separate issue. Small, reviewable pull requests get merged; large ones stall.\n`,
  );

  out.push(
    `## Definition of done\n\n- [ ] ${issue.deliverables}\n- [ ] \`pnpm lint\`, \`pnpm typecheck\`, \`pnpm test\` and \`pnpm format:check\` all pass\n- [ ] New behaviour is covered by tests that fail without the change\n- [ ] Documentation updated where the issue calls for it\n- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — CI enforces this\n- [ ] The pull request explains *why*, not only *what*\n`,
  );

  out.push(
    `## Getting set up\n\n\`\`\`bash\ngit clone https://github.com/Kyvera-Labs/verixa.git\ncd verixa\npnpm install          # also generates the Prisma client\npnpm test             # database-backed tests skip themselves without Postgres\n\`\`\`\n\nFor the database-backed parts, \`docker compose up postgres\` gives you one preconfigured.\n`,
  );

  out.push(
    `## References\n\n- [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) — workflow, commit format, review expectations\n- [Architecture overview](../blob/main/planning/ARCHITECTURE.md)\n- [Full roadmap](../blob/main/planning/ROADMAP.md)\n- [Phase ${phase.number} specification](../blob/main/${phase.file})\n- [\`docs/guides/domain-modeling.md\`](../blob/main/docs/guides/domain-modeling.md) — the layering rules this codebase follows\n`,
  );

  out.push(
    `---\n\n**Complexity:** ${complexity.label} — ${complexity.hint}\n\n**New to the project?** Comment to claim this issue before starting, so two people do not build the same thing. Questions on the issue are welcome and are not a sign you should not be working on it.\n`,
  );

  return out.join("\n");
}

/** The issue title as it appears on GitHub. */
export function renderIssueTitle(issue) {
  return `[${issue.id}] ${issue.title.replace(/`/g, "")}`;
}

/** Labels for an issue, derived from its phase, layer and complexity. */
export function labelsFor(issue) {
  const layer = layerOf(issue.filesAffected);
  const labels = [`phase-${issue.phase}`];

  const layerLabel = {
    "domain-entity": "domain",
    "domain-value-object": "domain",
    port: "use-case",
    "use-case": "use-case",
    adapter: "infrastructure",
    infrastructure: "infrastructure",
    http: "api",
    tests: "testing",
    ops: "ops",
    docs: "docs",
  }[layer];
  if (layerLabel) labels.push(layerLabel);

  if (
    /security|password|token|auth|crypto|rate.?limit|abuse/i.test(
      `${issue.title} ${issue.description}`,
    )
  ) {
    labels.push("security");
  }
  if (issue.complexity === "S" && issue.dependencies.length <= 1) labels.push("good first issue");
  if (/stellar|anchor|ledger|on-chain/i.test(`${issue.title} ${issue.description}`))
    labels.push("stellar");

  return [...new Set(labels)];
}

export { layerOf, packageOf };
