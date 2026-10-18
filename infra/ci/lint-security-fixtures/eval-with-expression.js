// Fixture: security/detect-eval-with-expression (Issue 208).
//
// Evaluates a string chosen by the caller. The whole ruleset exists so this
// line is caught before it reaches a pull request.

export function runExpression(expression) {
  return eval(expression);
}
