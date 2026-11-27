import type { UserRepository } from "@verixa/identity";

import type { CredentialRepository } from "./credential-repository.js";
import type {
  EmailVerificationTokenRepository,
  PasswordResetTokenRepository,
} from "./verification-token-repository.js";

/** Repositories available inside a credentials unit of work, all on one transaction. */
export interface CredentialsRepositories {
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly emailVerificationTokens: EmailVerificationTokenRepository;
  readonly passwordResetTokens: PasswordResetTokenRepository;
}

/**
 * Runs work spanning the identity and credentials contexts atomically, so registration never
 * creates a user without a credential (an account nobody could log into or re-register). It lives
 * here because credentials depends on identity, never the reverse.
 */
export interface CredentialsUnitOfWork {
  run<T>(work: (repositories: CredentialsRepositories) => Promise<T>): Promise<T>;
}
