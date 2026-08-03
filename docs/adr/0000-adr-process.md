# ADR-0000: Architecture Decision Record process

## Status

Accepted

## Context

"We chose X" without "because Y" decays into a project's least useful kind of
technical debt: it survives in the code, but the reasoning that justified it
doesn't, so six months later nobody — including the person who made the
call — can tell whether the reason still applies, was situational, or was
simply wrong. Verixa is meant to be read and learned from as much as run, so
losing that reasoning is a bigger cost here than in a typical closed-source
codebase: the _why_ is half the educational value.

## Decision

Every non-trivial architectural decision (a new dependency that shapes how
code gets written, a cross-cutting pattern like `Result<T,E>` or the branded-
ID scheme, a layering rule, a choice between two frameworks/protocols/data
stores) gets recorded as an ADR in `docs/adr/`, using this template:

```markdown
# ADR-XXXX: <short, decision-focused title>

## Status

Proposed | Accepted | Superseded by ADR-YYYY

## Context

What problem forced this decision? What constraints applied?

## Decision

What was actually decided, stated plainly.

## Consequences

What does this make easier, harder, or foreclose? Include real tradeoffs,
not just upside.

## Alternatives Considered

What else was on the table, and specifically why it was rejected — not just
that it was.
```

Rules:

- **Numbered sequentially**, zero-padded to four digits (`0000`, `0001`, ...),
  never reused even if a decision is later reversed.
- **Immutable once Accepted.** A changed decision gets a _new_ ADR whose
  Status line reads `Supersedes ADR-XXXX`; the old ADR's Status is edited to
  `Superseded by ADR-YYYY` rather than deleted or rewritten. The history of
  _why we changed our mind_ is itself worth keeping.
- **Written at decision time, not retroactively reconstructed later** —
  reasoning reconstructed after the fact tends to be rationalization for
  whatever was already built, not the actual constraints that were weighed.
- Not every decision needs one. A decision is ADR-worthy if reversing it
  later would be expensive, or if a reasonable person could have gone the
  other way and a future contributor would benefit from knowing why this way
  won. Routine implementation choices (naming, file layout within an already-
  decided pattern) don't need one.

## Consequences

- Every future issue that makes an architectural call is expected to add or
  reference an ADR, not just implement the decision silently.
- The ADR log becomes a chronological record of the project's reasoning,
  independent of git history (which records _what_ changed, not _why it was
  the right call at the time_) and independent of any single contributor's
  memory.
- Adds a small amount of overhead per non-trivial decision — considered
  worthwhile given Verixa's educational goal (see Context above).

## Alternatives Considered

- **No formal process, rely on commit messages and code comments** —
  rejected: commit messages document a diff, not a decision, and get lost in
  history; comments explain code, not the alternatives that were rejected in
  favor of it.
- **RFC process (proposal → discussion → decision) instead of lightweight
  ADRs** — deferred, not rejected: an RFC process (Phase 25) fits
  decisions that need broad discussion before being made. ADRs fit decisions
  that have already been made and need their reasoning preserved. The two
  are complementary, not competing — an RFC's outcome can itself produce an
  ADR.
