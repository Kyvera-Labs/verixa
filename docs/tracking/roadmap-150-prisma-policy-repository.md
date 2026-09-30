# Tracking: [150] policies table, versioning, & PrismaPolicyRepository

## Status

**Blocked** — depends on #86 (roadmap 149), which is not merged.

- Issue: https://github.com/Kyvera-Labs/verixa/issues/87
- Phase: 08 — Authorization: ABAC / Policy Engine, roadmap issue 150
- Verified at: `138d1e0` (`master`)

This is a tracking note, not an implementation.

## Blocking dependencies

- #86 — roadmap 149: `PolicyRepository` port & in-memory fake (open)
- #78 — roadmap 141: policy domain model (`Policy`, `Rule`, `Effect`, `Condition`) (open)

## Why this is blocked

`PrismaPolicyRepository` must implement #86's port and pass its shared contract
suite — the pattern every adapter in this repository follows, and the thing that
keeps the in-memory fake and the real database honest about behaving
identically. Neither the port nor its contract suite exists on `master`, and
`packages/authorization` — where
`infrastructure/persistence/prisma-policy-repository.ts` would live — is not on
`master` at all. The policy model from #78 is also a prerequisite for the mapper.

## What unblocks it

#86 (and #78) merging, which establishes the port, the in-memory fake, and the
contract suite the adapter must satisfy.

## Plan once unblocked

1. Add the `Policy` Prisma model (id, name, target selector, serialized rule
   tree, version, status `draft`/`published`/`archived`) to
   `packages/database/prisma/schema.prisma`, storing the DSL source alongside the
   parsed AST for auditability.
2. Implement `PrismaPolicyRepository` against #86's port, with a mapper, and make
   it pass the shared contract suite.
3. Enforce append-only version history: publishing a new version must never
   mutate a prior published row.
