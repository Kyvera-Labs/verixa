# Writing Docs

How to add a page to the documentation site, and the handful of ways
Markdown that looks fine on GitHub can break the site build.

Configuration: `docs/.vitepress/config.ts`. The CI job is `docs` in
`.github/workflows/ci.yml`.

## The rule

**`docs/` is the docs site.** Every Markdown file under it becomes a page, and
`pnpm docs:build` fails on a link that doesn't resolve. There's no separate
"site content" to keep in sync. The same file is what a contributor reads on
GitHub and what a visitor reads on the site.

## Running the site locally

```sh
pnpm docs:dev       # dev server with hot reload, at http://localhost:5173
pnpm docs:build     # the exact check CI runs; output in docs/.vitepress/dist
pnpm docs:preview   # serve the built output, to check what CI will upload
```

Run `pnpm docs:build` before pushing a docs change. The dev server renders
pages on demand and doesn't check links across the whole site, so it can look
fine while the build fails.

## Adding a page

1. **Put the file in the folder for its kind of content:** `docs/guides/` for
   how-tos and conventions, `docs/guides/tutorials/` for step-by-step
   walkthroughs, `docs/guides/testing/` for testing conventions,
   `docs/adr/NNNN-title.md` for decisions, and `docs/security/` for security
   design and threat models. Use kebab-case file names.
2. **Start it with a single `# Title` heading.** The sidebar uses that heading
   as the page's label.
3. **That's it for the sidebar.** Sidebar _sections_ are declared in
   `SECTIONS` in `config.ts`, and each section lists the pages in its folder at
   build time, sorted by file name. A new file in an existing folder appears
   automatically. Only a new **folder** needs a new entry in `SECTIONS`; until
   it has one, its pages build but are reachable only by link.

### Why the sidebar lists folders, not pages

The alternative was a hand-written list of every page. That gives full control
over order, but with about 90 pages and most PRs adding one, it drifts the
first time someone forgets to register a page. The page then exists only for
people who already know its URL. Listing a folder can't drift. What it gives up
is per-page ordering: pages sort by file name, which happens to suit the
numbered ADRs. Grouping the sidebar by audience (Getting started,
Architecture, …) and full-text search are Issue 423, which builds on this
scaffold.

## Linking

- **Link to other docs with a relative path that includes `.md`**:
  `[domain modeling](../domain-modeling.md)`. It works on GitHub as-is, and
  VitePress turns it into the page URL.
- **Linking to code or files outside `docs/` is fine**:
  `[the factory](../../../packages/testing-kit/factories/user.ts)`. GitHub
  resolves it on its own. On the site, `config.ts` rewrites any relative link
  that leaves `docs/` into the file's URL on GitHub, because the site has no
  copy of the source tree to serve.
- **A link that should be a page and isn't fails the build.**
  `ignoreDeadLinks` is deliberately off. That's what makes the CI job a check
  rather than a formality: a renamed doc with stale links to it can't merge.
- **Don't paste a link to a file on your own machine** (`file:///C:/…`). It
  works for you and nobody else, and the build can't catch it, because
  VitePress treats any URL with a scheme as external.

## The Vue gotcha

VitePress compiles every Markdown page into a Vue component. Two things that
are harmless on GitHub break the build, with errors that point at a line
number in the _compiled_ page rather than your file.

**Double braces are template interpolation, even inside inline code.** An
inline code span containing <code v-pre>{{.Size}}</code> makes Vue try to
evaluate `.Size` as JavaScript (`Error parsing JavaScript expression`). Fenced code blocks are safe, because
VitePress escapes them. For inline code, write the span as HTML with `v-pre`,
which renders identically on GitHub:

```md
<code v-pre>docker images verixa-api:ci --format 'size {{.Size}}'</code>
```

For a whole section of prose that needs braces, wrap it in a `::: v-pre`
container. That shows up as literal `:::` lines on GitHub, so prefer the
inline form.

**Something that looks like an HTML tag at the start of a line is parsed as
one.** If a code span such as `npm install <anything>` wraps so that the new
line _begins_ with `<anything>`, the line is read as an unclosed HTML element
(`Element is missing end tag`). Keep the code span on one line. In plain prose, a generic like
`Result<T, E>` must be in backticks for the same reason.

## Showing real code: snippet imports

A tutorial's code should be code that runs. Rather than pasting it, import a
region of a real file:

```md
<<< @/../tests/examples/approve-verification.spec.ts#unit-test{ts}
```

`@` is `docs/`, so `@/../` is the repository root. The region is marked in the
source file with comments, which the import strips:

```ts
// #region unit-test
import { aVerificationRequest } from "@verixa/testing-kit";
/* … */
// #endregion unit-test
```

The file is a test that runs in `pnpm test`, so the example in the docs is
exactly what CI ran. If someone deletes the file, VitePress fails the build. If
someone renames the region, VitePress on its own would quietly inline the
_whole_ file, so `config.ts` adds a check (`verixa-snippet-regions`) that fails
the build and names the page and region. Either way the page can't go stale
silently. Put the example in the real test file where it belongs;
`tests/examples/` is for examples that have no better home.

**Trade-off:** GitHub doesn't understand `<<<` and shows the line literally.
Pages that rely on snippet imports are written for the site, so follow each
import with a plain link to the source file for GitHub readers. The rejected
alternative, copying code into fenced blocks, reads well everywhere but drifts
from the code silently, and a tutorial whose examples don't compile is worse
than none.

## Why VitePress

The issue that introduced the site (422) chose VitePress. The reasons:

- **TypeScript configuration in a TypeScript repository.** `config.ts` is
  ordinary TypeScript using Node's standard library, so the sidebar and
  link-rewriting logic is code any contributor here can read.
- **It consumes existing Markdown unchanged.** Adopting it took two
  `v-pre` spans and one re-wrapped line across ~90 files. No front matter
  and no file moves.
- **Low operational overhead.** One dev dependency and a static `dist/` folder
  that any static host can serve. No server and no search service (local
  search is a built-in option for Issue 423).

Alternatives considered:

- **Docusaurus.** It's capable and widely used, but its pages are React and
  MDX. MDX is stricter than GitHub Markdown (a stray `<` or `{` is a JSX parse
  error everywhere, not just in a few cases), so existing docs would need
  rewrites. It's also a much heavier dependency tree for a repository that
  doesn't otherwise use React.
- **MkDocs (Material).** Its output is excellent, but it's a Python toolchain:
  a second language runtime, package manager and lockfile in CI and on every
  contributor's machine, solely for docs.
- **No generator; keep browsing on GitHub.** Free, and it works today. But
  nothing checks links, and there's no navigation beyond folder listings.
  That's the "folder contributors have to `grep`" Issue 422 exists to replace.

### What this costs

VitePress pins its own Vite major (5.x). This workspace overrides Vite to
`^6.4.4` for security advisories (`pnpm-workspace.yaml`), so the site builds
on Vite 6, outside what VitePress declares support for. It builds and serves
cleanly today. A VitePress upgrade that relies on Vite 5-only behavior would
show up as a `docs:build` failure in CI, not in production.
