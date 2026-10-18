// Fixture: security/detect-buffer-noassert (Issue 208).
//
// The `noAssert` argument skips the bounds check, so a short buffer reads
// memory that is not the caller's to read.

export function readFirstByte(buffer) {
  return buffer.readUInt8(0, true);
}
