// VitePress site for docs/ (Issue 422). See docs/guides/writing-docs.md for
// how to add a page and why the site is configured the way it is.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type DefaultTheme } from "vitepress";

const DOCS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DOCS_ROOT, "..");

/**
 * Where links to files outside docs/ point on the built site. The same Markdown
 * is read on GitHub, where `../../packages/identity/index.ts` resolves on its
 * own; on the site there is no such file to serve.
 */
const SOURCE_BASE_URL = "https://github.com/Kyvera-Labs/verixa/blob/main";

/**
 * Sidebar sections, in reading order. The sections are hand-written; each
 * section's pages are listed from its folder at build time.
 *
 * Rejected: listing every page by hand. That gives full control over order,
 * but with ~90 pages added to by most PRs it drifts on the first doc someone
 * forgets to register, and the page then exists only for people who know its
 * URL. Generating items from folders cannot drift. What it gives up is per-page
 * ordering (pages sort by file name, which suits the numbered ADRs), and that
 * grouping by audience is Issue 423's job, not this scaffold's.
 */
const SECTIONS: readonly { text: string; dir: string }[] = [
  { text: "Guides", dir: "guides" },
  { text: "Tutorials", dir: "guides/tutorials" },
  { text: "Testing", dir: "guides/testing" },
  { text: "Tools", dir: "guides/tools" },
  { text: "Architecture decisions", dir: "adr" },
  { text: "Security", dir: "security" },
  { text: "Security incidents", dir: "security/incidents" },
  { text: "Performance", dir: "performance" },
  { text: "Runbooks", dir: "runbooks" },
  { text: "Tracking", dir: "tracking" },
];

/** The page's first `# ` heading, which is what every doc in the repo starts with. */
function pageTitle(file: string): string {
  const heading = /^#\s+(.+)$/m.exec(readFileSync(file, "utf8"));
  return heading?.[1]?.trim() ?? posix.basename(file, ".md");
}

function sectionItems(dir: string): DefaultTheme.SidebarItem[] {
  return readdirSync(join(DOCS_ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      text: pageTitle(join(DOCS_ROOT, dir, name)),
      link: `/${dir}/${name.replace(/\.md$/, "")}`,
    }));
}

/**
 * A `#region <name>` start marker as a line comment (`//`, `#`) or `<!-- -->`,
 * matching what VitePress's snippet plugin accepts for the languages in this
 * repo. Parsed with string operations rather than one regular expression, which
 * the security lint rightly flags as prone to catastrophic backtracking.
 */
const COMMENT_PREFIXES = ["//", "#", "<!--"] as const;

function hasRegion(source: string, name: string): boolean {
  return source.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    const prefix = COMMENT_PREFIXES.find((candidate) => line.startsWith(candidate));
    if (prefix === undefined) {
      return false;
    }
    let marker = line.slice(prefix.length);
    if (marker.endsWith("-->")) {
      marker = marker.slice(0, -"-->".length);
    }
    marker = marker.trim();
    if (marker.startsWith("#")) {
      marker = marker.slice(1).trim();
    }
    return marker === `region ${name}`;
  });
}

/** Relative hrefs only: not a URL with a scheme, not root-absolute, not a bare `#anchor`. */
const RELATIVE_HREF = /^(?![a-z][a-z0-9+.-]*:|\/|#)/i;

export default defineConfig({
  title: "Verixa",
  description:
    "Open-source infrastructure for authentication, authorization, identity, verification, audit logging, security, and governance.",
  // Dead links fail the build on purpose: it is what makes `pnpm docs:build`
  // in CI a check rather than a formality. Links leaving docs/ are rewritten
  // below, not ignored, so that this stays a blanket rule.
  ignoreDeadLinks: false,
  lastUpdated: false,
  vite: {
    // An inline PostCSS config stops Vite searching parent directories for
    // one, so the build is the same wherever the repository is checked out
    // (a postcss.config.js above the clone was otherwise picked up).
    css: { postcss: {} },
  },
  markdown: {
    config(md) {
      // A relative link that leaves docs/ (`../../packages/...`, `../../LICENSE`)
      // is correct on GitHub and has no page on the site. Rewriting it to the
      // file on GitHub keeps the source readable in both places without
      // editing ~66 links across existing docs, and keeps VitePress's dead-link
      // check meaningful for everything that *should* be a page.
      md.core.ruler.push("verixa-source-links", (state) => {
        const env = state.env as { relativePath?: string };
        if (env.relativePath === undefined) {
          return;
        }
        const pageDir = dirname(join(DOCS_ROOT, env.relativePath));

        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === "link_open" ? token.attrGet("href") : null;
            if (href === null || !RELATIVE_HREF.test(href)) {
              continue;
            }
            const [path = "", hash] = href.split("#", 2);
            const target = resolve(pageDir, path);
            if (relative(DOCS_ROOT, target).startsWith("..")) {
              const repoPath = relative(REPO_ROOT, target).split("\\").join("/");
              token.attrSet("href", `${SOURCE_BASE_URL}/${repoPath}${hash ? `#${hash}` : ""}`);
            }
          }
        }
      });

      // `<<< @/file.ts#region` imports a region of a real file. VitePress fails
      // the build when the *file* is missing, but when the *region* is
      // missing it silently inlines the whole file, so a renamed region in a
      // test would turn a tutorial example into a page-long dump without
      // anything failing. This makes a missing region fail the build too,
      // with the page and region named in the error.
      md.core.ruler.push("verixa-snippet-regions", (state) => {
        for (const token of state.tokens) {
          // Set by VitePress's snippet plugin on the fence token it creates:
          // [absolute file path, region name or ""].
          const snippet: unknown = Reflect.get(token, "src");
          if (!Array.isArray(snippet)) {
            continue;
          }
          const [file, region] = snippet as [string, string];
          if (region === "" || !existsSync(file)) {
            continue; // No region requested; a missing file already fails the build.
          }
          if (!hasRegion(readFileSync(file, "utf8"), region)) {
            const page = (state.env as { relativePath?: string }).relativePath ?? "a page";
            throw new Error(
              `Snippet region "#${region}" not found in ${relative(REPO_ROOT, file).split("\\").join("/")} (imported by docs/${page}).`,
            );
          }
        }
      });
    },
  },
  themeConfig: {
    sidebar: [
      ...SECTIONS.map((section) => ({
        text: section.text,
        collapsed: true,
        items: sectionItems(section.dir),
      })),
      { text: "Quarantine record", link: "/QUARANTINE" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/Kyvera-Labs/verixa" }],
  },
});
