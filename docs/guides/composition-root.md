# Composition Root & Dependency Inversion Guide

This guide explains Verixa's composition root architecture, wiring conventions, package boundary enforcement, and coverage gating.

---

## 1. The Role of the Composition Root

The composition root (`apps/api/src/composition-root.ts`) is the **single place** in the application where the object graph is constructed and concrete implementations are bound to interface ports.

### Invariant: Zero Infrastructure in Domain or Application Layers

Domain entities and application use cases depend exclusively on abstract ports:

- A use case like `RegisterWebAuthnCredential` requires an `AttestationVerifier` and repository interfaces (`MfaMethodRepository`, `WebAuthnChallengeRepository`, `WebAuthnCredentialRepository`).
- It has no knowledge of how those interfaces are fulfilled—whether in-memory fakes, Prisma database adapters, or hardware security modules.
- **The rule:** No file outside `composition-root.ts` may import concrete persistence adapters or construct repository instances.

### Why Explicit Construction Over Magic Dependency Injection (DI) Containers

We deliberately rejected runtime reflection/DI containers (e.g. Inversify, NestJS decorators, Awilix):

- **Compile-Time Type Safety:** When a use case gains a dependency or change in configuration, TypeScript immediately flags missing arguments in `composition-root.ts` at build time.
- **No Hidden Lifecycle Regressions:** In DI containers, missing or circular dependencies fail at runtime during production boot rather than at compile time.
- **Readability:** Anyone reading `composition-root.ts` can trace the exact instantiation and lifecycle of every component without memorizing container DSLs or token registries.

---

## 2. Multi-Factor Authentication (MFA) Wiring (`packages/mfa`)

Phase 06 introduces `@verixa/mfa` into the application container:

```ts
export interface MfaUseCases {
  readonly registerWebAuthnCredential: RegisterWebAuthnCredential;
  readonly verifyWebAuthnAssertion: VerifyWebAuthnAssertion;
}

export interface Container {
  readonly prisma: PrismaClient;
  readonly identity: IdentityUseCases;
  readonly credentials: CredentialUseCases;
  readonly audit: AuditUseCases;
  readonly mfa: MfaUseCases;
  readonly dispose: () => Promise<void>;
}
```

### WebAuthn Configuration & Verifiers

The composition root reads environment configuration for WebAuthn ceremony verification:

- `WEBAUTHN_RP_ID`: The Relying Party identifier (default: `localhost`).
- `WEBAUTHN_ORIGIN`: The expected caller origin (default: `http://localhost:3000`).

Both `RegisterWebAuthnCredential` and `VerifyWebAuthnAssertion` are instantiated with concrete verifiers:

- `WebAuthnAttestationVerifier`: Validates registration ceremonies and extracts attested public keys.
- `WebAuthnAssertionVerifier`: Validates authentication ceremonies, cryptographic signatures, and monotonic signature counter clone detection.

---

## 3. Package Encapsulation & Boundary Enforcement

Every context package (`@verixa/identity`, `@verixa/credentials`, `@verixa/mfa`) exposes a curated public surface via its root `index.ts`:

- Wildcard re-exports (`export *`) are forbidden. Each entity, port, and use case is explicitly re-exported.
- External packages cannot deep-import from internal paths (e.g. `@verixa/mfa/application/use-cases/...` or `@verixa/mfa/domain/...`).
- **ESLint Enforcement:** `eslint.config.mjs` enforces this with `no-restricted-imports`:
  ```js
  {
    files: ["**/*.ts"],
    ignores: ["packages/identity/**", "packages/credentials/**", "packages/mfa/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@verixa/identity/*", "@verixa/credentials/*", "@verixa/mfa/*"],
              message: "Import from the package root (`@verixa/mfa`), not a deep path.",
            },
          ],
        },
      ],
    },
  }
  ```

---

## 4. Coverage Gate Standard

Each domain context must pass automated test coverage thresholds in CI:

- **Statements:** ≥ 90%
- **Lines:** ≥ 90%
- **Functions:** ≥ 85%
- **Branches:** ≥ 85%

Interface-only ports, testing fakes, and generated database harnesses are excluded from coverage calculations so that the gate accurately measures application and domain logic without skewing from erased TypeScript interfaces.
