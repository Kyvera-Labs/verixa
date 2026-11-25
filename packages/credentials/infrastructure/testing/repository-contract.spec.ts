import { credentialRepositoryContract } from "./contracts/credential-repository.contract.js";
import {
  emailVerificationTokenRepositoryContract,
  passwordResetTokenRepositoryContract,
} from "./contracts/verification-token-repository.contract.js";
import { InMemoryCredentialRepository } from "./in-memory-credential-repository.js";
import {
  InMemoryEmailVerificationTokenRepository,
  InMemoryPasswordResetTokenRepository,
} from "./in-memory-verification-token-repositories.js";

credentialRepositoryContract(() => new InMemoryCredentialRepository());
emailVerificationTokenRepositoryContract(() => new InMemoryEmailVerificationTokenRepository());
passwordResetTokenRepositoryContract(() => new InMemoryPasswordResetTokenRepository());
