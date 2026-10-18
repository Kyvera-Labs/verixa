// Fixture: security/detect-object-injection (Issue 208).
//
// Writes through a key the caller supplies. `__proto__` and `constructor` are
// how this becomes prototype pollution; the rule cannot tell a closed union
// from an attacker-controlled string, which is why it is a warning and not an
// error.

export function setValue(store, key, value) {
  store[key] = value;
  return store;
}
