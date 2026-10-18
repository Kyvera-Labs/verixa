// Fixture: security/detect-non-literal-require (Issue 208).
//
// Loads whatever module name the caller supplies, which is arbitrary code
// execution if the name is not checked against a closed list.
//
// CommonJS on purpose: the rule targets `require`, and this repository's own
// source is ESM — the fixture documents the class even where it cannot apply.

module.exports = function load(moduleName) {
  return require(moduleName);
};
