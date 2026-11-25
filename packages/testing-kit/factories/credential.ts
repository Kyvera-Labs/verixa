import { Credential, type CredentialId, type CredentialUserId } from "@verixa/credentials";
import { asId, createId } from "@verixa/shared-kernel";

export interface CredentialFactoryOptions {
  id?: CredentialId | string;
  userId?: CredentialUserId | string;
  passwordHash?: string;
  failedAttempts?: number;
  lockedUntil?: Date;
}

/**
 * Creates a domain-valid `Credential` entity with sensible defaults and optional overrides.
 */
export function makeCredential(overrides: CredentialFactoryOptions = {}): Credential {
  const userId = (overrides.userId
    ? typeof overrides.userId === "string"
      ? asId<"UserId">(overrides.userId)
      : overrides.userId
    : createId<"UserId">()) as unknown as CredentialUserId;

  const passwordHash =
    overrides.passwordHash ?? "$argon2id$v=19$m=65536,t=3,p=4$fakeHashForTestingOnly";

  let credential = Credential.create({
    userId,
    passwordHash,
  });

  if (
    overrides.id ||
    overrides.failedAttempts !== undefined ||
    overrides.lockedUntil !== undefined
  ) {
    const id = overrides.id
      ? typeof overrides.id === "string"
        ? asId<"CredentialId">(overrides.id)
        : overrides.id
      : credential.id;

    credential = Credential.reconstitute({
      id,
      userId: credential.userId,
      passwordHash: credential.passwordHash,
      failedAttempts: overrides.failedAttempts ?? credential.failedAttempts,
      lockedUntil: overrides.lockedUntil ?? credential.lockedUntil,
      passwordHistory: credential.passwordHistory,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    });
  }

  return credential;
}
