// Fixture: security/detect-child-process (Issue 208).
//
// Shells out with a caller-supplied command — command injection in one line.

import { exec } from "node:child_process";

export function runCommand(command, callback) {
  return exec(command, callback);
}
