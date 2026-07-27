# Domain Modeling Conventions

This guide collects the recurring patterns used to model Verixa's domain
layer. It grows as later phases add value objects, entities, and aggregates —
for now it covers the first building block: branded identifiers.

## Branded identifiers

`@verixa/shared-kernel` exports `Id<Brand>`, a UUID string carrying a
compile-time-only "brand":

```ts
import { createId, type Id } from "@verixa/shared-kernel";

type UserId = Id<"UserId">;
type OrganizationId = Id<"OrganizationId">;

const userId: UserId = createId<"UserId">();
```

### Why not just use `string`?

This is the "primitive obsession" anti-pattern: using a general-purpose
primitive (`string`, `number`) to represent something with much narrower,
specific meaning (a user's identity). The problem isn't that it's wrong, it's
that the type system stops helping you:

```ts
function transferOwnership(userId: string, organizationId: string): void { ... }

// Both compile without complaint. Only one is correct.
transferOwnership(user.id, org.id);
transferOwnership(org.id, user.id); // arguments swapped — silent bug
```

Branding turns that into a compile-time error instead of a runtime one:

```ts
function transferOwnership(userId: UserId, organizationId: OrganizationId): void { ... }

transferOwnership(org.id, user.id); // Type error: OrganizationId is not assignable to UserId
```

### Nominal vs. structural typing

TypeScript's type system is _structural_ by default: two types are compatible
if their shapes match, regardless of name. That's usually a feature (it makes
duck typing and interface composition easy), but it's exactly what causes the
`UserId`/`OrganizationId` mix-up above — both are plain `string`s, so
structurally they're identical.

Branding is how you opt into _nominal_ typing (where names, not just shapes,
matter) for the specific cases where it's worth it. The `Branded<T, Brand>`
helper attaches a `unique symbol`-keyed property that only exists in the type
system, never at runtime:

```ts
type Branded<T, Brand extends string> = T & { readonly [brand]: Brand };
```

Because the branding property is declared with a `unique symbol` no other
code can produce, the only way to get a value typed as `Id<"UserId">` is to go
through `createId<"UserId">()` or `asId<"UserId">(value)` — a plain string
literal is never assignable, which is exactly what the `@ts-expect-error`
tests in `branded-id.spec.ts` verify.

### `createId` vs. `asId`

- **`createId<Brand>()`** generates a brand-new random UUID (via Node's
  built-in `crypto.randomUUID()`) — use this when creating a new entity.
- **`asId<Brand>(value)`** brands a string you already have (typically one
  read back from a database row) — it performs no validation, so only use it
  on values you already trust.

### Convention going forward

Every aggregate gets its own id brand named after the entity, e.g. `UserId`,
`OrganizationId`, `SessionId`. These are declared alongside the entity itself
(starting with `User` in Phase 02), not centrally in `shared-kernel` — the
shared kernel only owns the generic `Id<Brand>` mechanism.
