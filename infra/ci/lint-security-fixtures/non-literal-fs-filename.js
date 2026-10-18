// Fixture: security/detect-non-literal-fs-filename (Issue 208).
//
// Reads whatever path the caller supplies. Without a containment check that is
// a path traversal, and the rule cannot know whether one exists here.

import { readFileSync } from "node:fs";

export function loadFile(path) {
  return readFileSync(path, "utf8");
}
