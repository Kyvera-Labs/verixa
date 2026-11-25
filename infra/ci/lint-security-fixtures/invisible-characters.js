// Fixture: security/detect-invisible-characters (eslint-plugin-security 4).
//
// The "invisible backdoor": U+3164 HANGUL FILLER is a valid identifier
// character that renders as nothing. Destructuring it from the query string
// and passing it to exec() looks, to a reviewer, like a stray comma.

export function handler(query, exec) {
  const { timeout, ㅤ } = query;
  return exec(["ping -c 1 localhost", ㅤ], { timeout });
}
