/**
 * The security lint ruleset (issue 208), shared by the repository config and by
 * the fixture config the lint tests run against.
 *
 * ## Why this is one module rather than an inline block in `eslint.config.mjs`
 *
 * The acceptance criterion is that every enabled rule is proven to fire on a
 * deliberately vulnerable snippet. A fixture test that re-declared the rules
 * would prove the *test's* rules fire, not the repository's — and the two would
 * drift the first time somebody tuned a severity. Exporting the object means
 * `eslint.config.mjs` and the fixture config consume the same source, so the
 * fixtures are evidence about the real gate.
 *
 * ## Why the rules are not all `error`
 *
 * `eslint-plugin-security`'s recommended set is a reasonable starting point and
 * a poor finishing point. Its heuristics are deliberately noisy in places:
 * `detect-object-injection` fires on every dynamic property access, which in a
 * TypeScript codebase with a static type checker and no `any` at the boundary
 * is mostly guesswork. Three rules carry that shape of false positive, and each
 * one is either demoted or scoped rather than deleted — the alternative,
 * leaving everything on `warn`, means the security ruleset never fails a build.
 *
 * The rules that map to a concrete, low-noise vulnerability class are errors:
 * `eval`, child-process execution, non-literal `fs`/`require`/`RegExp`
 * construction (which is how user input becomes code or a path traversal),
 * catastrophic-backtracking regexes, weak randomness, the deprecated `Buffer`
 * constructors, and bidi-character source spoofing.
 */

import security from "eslint-plugin-security";

export const securityPlugin = security;

export const securityRules = {
  ...security.configs.recommended.rules,

  // -- Errors: the vulnerability classes this issue targets -----------------

  /** `eval(userInput)` — arbitrary code execution from a string. */
  "security/detect-eval-with-expression": "error",

  /** `child_process.exec(userInput)` — command injection. */
  "security/detect-child-process": "error",

  /** `fs.readFileSync(userPath)` — path traversal and arbitrary file read. */
  "security/detect-non-literal-fs-filename": "error",

  /** `new RegExp(userInput)` — regex injection and denial of service. */
  "security/detect-non-literal-regexp": "error",

  /** `require(userInput)` — arbitrary module load. */
  "security/detect-non-literal-require": "error",

  /** Catastrophic backtracking: `(a+)+$` is a denial-of-service primitive. */
  "security/detect-unsafe-regex": "error",

  /** `crypto.pseudoRandomBytes` — not cryptographically secure. */
  "security/detect-pseudoRandomBytes": "error",

  /** The `noAssert` argument skips bounds checks on `Buffer` reads/writes. */
  "security/detect-buffer-noassert": "error",

  /** `new Buffer(...)` is deprecated and uninitialized in some paths. */
  "security/detect-new-buffer": "error",

  /** `if (secret === provided)` — non-constant-time secret comparison. */
  "security/detect-possible-timing-attacks": "error",

  /** Trojan-source bidi control characters hide code from a reviewer. */
  "security/detect-bidi-characters": "error",

  // -- Warnings: real patterns whose heuristic is too broad to gate on ------

  /**
   * `object[userKey]` is flagged whether the key is attacker-controlled or a
   * literal from a closed union, and a typed codebase makes the two
   * indistinguishable to the rule. Left as a warning so it is visible in
   * review, not promoted to an error that would be suppressed wholesale.
   */
  "security/detect-object-injection": "warn",

  // -- Off: not applicable to this codebase --------------------------------

  /**
   * Flags Mustache template escaping. Verixa renders no Mustache templates —
   * the API answers JSON and, in a later phase, server-rendered review pages
   * with their own escaping policy (Issue 212). A rule that can only fire on
   * code this repository does not contain is a rule somebody eventually spends
   * an afternoon understanding for nothing.
   */
  "security/detect-disable-mustache-escape": "off",

  /**
   * Flags Express's body-parser method-override CSRF gap. The API is Fastify
   * and does not use that middleware; Issue 205 is the CSRF control that
   * matters here, and it is not a lint rule.
   */
  "security/detect-no-csrf-before-method-override": "off",
};
