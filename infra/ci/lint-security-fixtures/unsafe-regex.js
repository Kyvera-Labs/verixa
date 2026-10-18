// Fixture: security/detect-unsafe-regex (Issue 208).
//
// Catastrophic backtracking: a short input of "aaaa...b" against this pattern
// takes exponential time, so one request can stall the event loop.

export const trailingGroup = /^(a+)+$/;
