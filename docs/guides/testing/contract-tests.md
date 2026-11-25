# Contract tests for ports

An adapter is interchangeable only when it preserves the behavior callers
depend on. TypeScript can check that two adapters expose the same methods; it
cannot check that both enforce the same limits, ordering, or failure behavior.
Contract tests express those expectations once and run them against every
implementation, including in-memory fakes. They operationalize the Liskov
Substitution Principle at the hexagonal architecture's port boundaries.

`@verixa/testing-kit` exports `defineContractTests`. Give it named factories
and a spec that registers ordinary Vitest assertions:

```ts
import { defineContractTests } from "@verixa/testing-kit";

defineContractTests(
  [
    { name: "in-memory", factory: () => new InMemoryRateLimiter() },
    { name: "redis", factory: () => new RedisRateLimiter(redis) },
  ],
  (port) => {
    it("allows requests up to the limit", async () => {
      expect(await port().consume("user-1")).toMatchObject({ allowed: true });
    });
  },
);
```

The callback receives a getter because each assertion gets a fresh value from
its factory in `beforeEach`. This isolates stateful adapters between tests,
while every adapter still receives the exact same assertions. Factories may be
asynchronous when setup needs a connection or fixture.

`@verixa/testing-kit` is a dev-only package. Never re-export the harness from a
package that production code imports: it imports `vitest`, which is not
installed in the runtime image.

Keep the contract focused on the port's caller-visible guarantees. Do not put
adapter-specific implementation details in the shared spec; those belong in
the adapter's own tests. A contract that is too broad becomes a second
implementation of the adapter rather than a check of the boundary.

The alternative is to duplicate similar assertions in each adapter suite.
That looks simpler initially, but the copies drift: a new assertion can land
in one suite and leave fakes falsely reassuring their callers. Sharing the
spec makes that drift visible by construction.

## Failure modes are part of the contract

External-service adapters are the likeliest source of _"works on my fake,
breaks in production"_ bugs. Hand-rolled fakes often implement only happy
paths, silently masking what happens when:

1. **The network times out.** Upstream calls must abort within a defined
   deadline and yield an explicit domain timeout error (for example
   `CaptchaTimeoutError`, `GeoIpTimeoutError`, `NotificationTimeoutError`).
2. **The response is malformed.** Non-JSON payloads or unexpected structures
   must yield a domain malformed-response error rather than an unhandled JSON
   parse exception.
3. **The upstream service is down.** HTTP 502/503/504 responses must map
   cleanly onto expected `DomainError` instances rather than unhandled promise
   rejections.

Shared contract suites must include these failure modes as first-class
assertions.

## Coverage checklist

### External-service adapter ports (Issue 411)

| Port                     | Package                 | Implementations tested                             | Contract test file                                                                   |
| :----------------------- | :---------------------- | :------------------------------------------------- | :----------------------------------------------------------------------------------- |
| **`CaptchaVerifier`**    | `@verixa/rate-limiting` | `NoopCaptchaVerifier`, `HttpCaptchaVerifier`       | `packages/rate-limiting/infrastructure/testing/captcha-verifier.contract.spec.ts`    |
| **`GeoIpResolver`**      | `@verixa/rate-limiting` | `StaticGeoIpResolver`, `HttpGeoIpResolver`         | `packages/rate-limiting/infrastructure/testing/geo-ip-resolver.contract.spec.ts`     |
| **`NotificationSender`** | `@verixa/notifications` | `NoopNotificationSender`, `HttpNotificationSender` | `packages/notifications/infrastructure/testing/notification-sender.contract.spec.ts` |

### Persistence repository ports (Issues 409 and 410)

| Port                                   | Package                 | Implementations tested                                                               | Contract test file                                                                                    |
| :------------------------------------- | :---------------------- | :----------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **`UserRepository`**                   | `@verixa/identity`      | `InMemoryUserRepository`, `PrismaUserRepository`                                     | `packages/identity/infrastructure/testing/contracts/user-repository.contract.ts`                      |
| **`OrganizationRepository`**           | `@verixa/identity`      | `InMemoryOrganizationRepository`, `PrismaOrganizationRepository`                     | `packages/identity/infrastructure/testing/contracts/organization-repository.contract.ts`              |
| **`OrganizationMembershipRepository`** | `@verixa/identity`      | `InMemoryOrganizationMembershipRepository`, `PrismaOrganizationMembershipRepository` | `packages/identity/infrastructure/testing/contracts/organization-membership-repository.contract.ts`   |
| **`CredentialRepository`**             | `@verixa/credentials`   | `InMemoryCredentialRepository`, `PrismaCredentialRepository`                         | `packages/credentials/infrastructure/testing/contracts/credential-repository.contract.ts`             |
| **`EmailVerificationTokenRepository`** | `@verixa/credentials`   | `InMemoryEmailVerificationTokenRepository`, `PrismaEmailVerificationTokenRepository` | `packages/credentials/infrastructure/testing/contracts/verification-token-repository.contract.ts`     |
| **`PasswordResetTokenRepository`**     | `@verixa/credentials`   | `InMemoryPasswordResetTokenRepository`, `PrismaPasswordResetTokenRepository`         | `packages/credentials/infrastructure/testing/contracts/verification-token-repository.contract.ts`     |
| **`SessionRepository`**                | `@verixa/sessions`      | `InMemorySessionRepository`, `PrismaSessionRepository`                               | `packages/sessions/infrastructure/testing/contracts/session-repository.contract.ts`                   |
| **`RevocationList`**                   | `@verixa/sessions`      | `InMemoryRevocationList`, `RedisRevocationList`                                      | `packages/sessions/infrastructure/testing/contracts/revocation-list.contract.ts`                      |
| **`RoleRepository`**                   | `@verixa/authorization` | `InMemoryRoleRepository`, `PrismaRoleRepository`                                     | `packages/authorization/infrastructure/testing/contracts/role-repository.contract.ts`                 |
| **`PermissionRepository`**             | `@verixa/authorization` | `InMemoryPermissionRepository`, `PrismaPermissionRepository`                         | `packages/authorization/infrastructure/testing/contracts/permission-repository.contract.ts`           |
| **`UserRoleAssignmentRepository`**     | `@verixa/authorization` | `InMemoryUserRoleAssignmentRepository`, `PrismaUserRoleAssignmentRepository`         | `packages/authorization/infrastructure/testing/contracts/user-role-assignment-repository.contract.ts` |
| **`PolicyRepository`**                 | `@verixa/authorization` | `InMemoryPolicyRepository`, `PrismaPolicyRepository`                                 | `packages/authorization/infrastructure/testing/contracts/policy-repository.contract.ts`               |
| **`PolicyCache`**                      | `@verixa/authorization` | `InMemoryPolicyCache`, `RedisPolicyCache`                                            | `packages/authorization/infrastructure/cache/testing/policy-cache-contract.ts`                        |
| **`VerificationRequestRepository`**    | `@verixa/verification`  | `InMemoryVerificationRequestRepository`, `PrismaVerificationRequestRepository`       | `packages/verification/infrastructure/testing/contracts/verification-request-repository.contract.ts`  |
| **`VerificationProvider`**             | `@verixa/verification`  | `ManualReviewProvider`, `AutomatedCheckProvider`                                     | `packages/verification/infrastructure/testing/contracts/verification-provider.contract.ts`            |

## Writing a new contract test

When introducing a new port with multiple adapters:

1. Place the shared contract spec next to the adapters, in
   `infrastructure/testing/<port-name>.contract.spec.ts`.
2. Register every conforming adapter in the implementations array with a
   `factory` that returns a fresh instance.
3. Test valid inputs, boundary conditions, and invalid inputs.
4. Test failure modes (timeouts, 5xx responses, malformed payloads).
5. Add the newly covered port to the checklist above.
