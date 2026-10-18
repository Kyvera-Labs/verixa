// Fixture: security/detect-possible-timing-attacks (Issue 208).
//
// `===` short-circuits on the first differing byte, so the time the check takes
// leaks how much of the secret the caller guessed correctly. The rule keys on
// the comparison living in an `if` and on an operand named like a secret, which
// is exactly the shape a hand-rolled credential check has.
//
// The fix is a constant-time comparison (`crypto.timingSafeEqual`) over
// fixed-length digests.

export function matchesSecret(secret, provided) {
  if (secret === provided) {
    return true;
  }
  return false;
}
