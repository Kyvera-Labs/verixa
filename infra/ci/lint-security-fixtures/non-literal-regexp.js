// Fixture: security/detect-non-literal-regexp (Issue 208).
//
// Compiles a pattern chosen by the caller. Attacker-controlled patterns bring
// their own denial-of-service payload.

export function compilePattern(pattern) {
  return new RegExp(pattern);
}
