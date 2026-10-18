// Fixture: security/detect-new-buffer (Issue 208).
//
// The rule targets a non-literal argument: `new Buffer(userSize)` has, across
// Node versions, produced an uninitialized buffer that leaks heap contents and
// an unsafe-by-type buffer where a size was expected.

export function allocateBuffer(size) {
  return new Buffer(size);
}
