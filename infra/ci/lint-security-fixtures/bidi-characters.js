// Fixture: security/detect-bidi-characters (Issue 208).
//
// The string below contains U+202E RIGHT-TO-LEFT OVERRIDE, which reverses
// the rendered order of the characters after it. A reviewer reads a
// harmless filename; the runtime sees something else entirely.

export const disguised = "photo‮evilexe.3pm";
