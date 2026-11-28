import { Result } from "@verixa/shared-kernel";

import type { LogoutEverywhere } from "../application/use-cases/logout-everywhere.js";

/**
 * Satisfies credentials' `SessionRevoker` port structurally, without depending on
 * `@verixa/credentials`.
 *
 * Failures are logged to stderr and swallowed, because revocation during a password reset is
 * best-effort and must not fail an otherwise successful reset.
 */
export class SessionsPackageRevoker {
  constructor(private readonly logoutEverywhere: LogoutEverywhere) {}

  async revokeAllForUser(userId: string): Promise<void> {
    const result = await this.logoutEverywhere.execute({ userId });
    if (Result.isErr(result)) {
      process.stderr.write(
        `sessions: revokeAllForUser(${userId}) failed: ${result.error.message}\n`,
      );
    }
  }
}
