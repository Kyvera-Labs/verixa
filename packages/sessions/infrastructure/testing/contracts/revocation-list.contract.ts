import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { RevocationList } from "../../../application/ports/revocation-list.js";
import type { SessionId } from "../../../domain/entities/session.js";

function createSessionId(): SessionId {
  return createId<"SessionId">();
}

const ONE_MINUTE_MS = 60 * 1000;

/**
 * Behavioural contract for every {@link RevocationList}, run against the in-memory list and, when
 * available, `RedisRevocationList` (see docs/guides/testing.md). `createList` may be async. TTL
 * expiry and fail-closed behaviour are tested in each adapter's own spec.
 */
export function revocationListContract(
  createList: () => RevocationList | Promise<RevocationList>,
): void {
  describe("RevocationList contract", () => {
    it("reports a never-revoked session as not revoked", async () => {
      const list = await createList();

      await expect(list.isRevoked(createSessionId())).resolves.toBe(false);
    });

    it("reports a revoked session as revoked", async () => {
      const list = await createList();
      const sessionId = createSessionId();

      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(sessionId)).resolves.toBe(true);
    });

    it("revokes only the named session, not others", async () => {
      const list = await createList();
      const revoked = createSessionId();
      const untouched = createSessionId();

      await list.revoke(revoked, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(revoked)).resolves.toBe(true);
      await expect(list.isRevoked(untouched)).resolves.toBe(false);
    });

    it("is idempotent — revoking twice leaves the session revoked", async () => {
      const list = await createList();
      const sessionId = createSessionId();

      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));
      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(sessionId)).resolves.toBe(true);
    });
  });
}
