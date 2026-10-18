// Fixture: security/detect-pseudoRandomBytes (Issue 208).
//
// `pseudoRandomBytes` is not cryptographically secure; anything derived from it
// (a token, a reset code, a key) is guessable.

import crypto from "node:crypto";

export function generateToken() {
  return crypto.pseudoRandomBytes(16).toString("hex");
}
