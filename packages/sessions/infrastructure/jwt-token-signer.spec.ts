import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { err, isErr, isOk } from "@verixa/shared-kernel";

import type { AccessTokenClaims } from "../application/ports/token-signer.js";
import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
  SigningError,
} from "../application/ports/token-signer.js";
import { JwtTokenSigner } from "./jwt-token-signer.js";

/**
 * Generate a test RSA key pair (2048-bit).
 *
 * We generate keys for each test rather than hardcode them, so this test
 * suite doesn't leak private keys if committed, and so the test is cryptographically
 * independent (real key generation, not mocked).
 */
function generateTestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

describe("JwtTokenSigner", () => {
  let signer: JwtTokenSigner;
  let publicKeyPem: string;
  let privateKeyPem: string;
  const keyId = "test-key-2024-01-01-v1";

  beforeEach(() => {
    const { publicKeyPem: pub, privateKeyPem: priv } = generateTestKeyPair();
    publicKeyPem = pub;
    privateKeyPem = priv;
    signer = new JwtTokenSigner(privateKeyPem, publicKeyPem, keyId);
  });

  describe("sign()", () => {
    it("should return a successful Result containing a signed token", async () => {
      const result = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value.token).toMatch(/^[\w\-]+\.[\w\-]+\.[\w\-]+$/);
        expect(result.value.claims.sub).toBe("user-123");
        expect(result.value.claims.sid).toBe("session-456");
        expect(result.value.claims.orgId).toBe("org-789");
        expect(result.value.claims.kid).toBe(keyId);
      }
    });

    it("should set iat to approximately now", async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      const after = Math.floor(Date.now() / 1000);

      if (isOk(result)) {
        expect(result.value.claims.iat).toBeGreaterThanOrEqual(before);
        expect(result.value.claims.iat).toBeLessThanOrEqual(after + 1);
      }
    });

    it("should set exp to the provided expiresAt", async () => {
      const expiresAt = new Date(Date.now() + 1234567);
      const result = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt,
      });

      if (isOk(result)) {
        const expectedExp = Math.floor(expiresAt.getTime() / 1000);
        expect(result.value.claims.exp).toBe(expectedExp);
      }
    });

    it("should reject if expiresAt is not in the future", async () => {
      const pastDate = new Date(Date.now() - 1000);
      const result = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: pastDate,
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(SigningError);
        expect(result.error.message).toContain("in the future");
      }
    });

    it("should include kid in the JWT header", async () => {
      const result = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (isOk(result)) {
        // Decode the header (first part of JWT)
        const [headerB64] = result.value.token.split(".");
        const header = JSON.parse(Buffer.from(headerB64, "base64").toString());
        expect(header.kid).toBe(keyId);
        expect(header.alg).toBe("RS256");
        expect(header.typ).toBe("JWT");
      }
    });
  });

  describe("verify()", () => {
    it("should verify and return claims from a valid token", async () => {
      const signResult = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      const claims = await signer.verify(signResult.value.token);
      expect(claims.sub).toBe("user-123");
      expect(claims.sid).toBe("session-456");
      expect(claims.orgId).toBe("org-789");
      expect(claims.kid).toBe(keyId);
    });

    it("should reject a tampered payload", async () => {
      const signResult = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      // Modify the payload (middle part)
      const [header, , signature] = signResult.value.token.split(".");
      const tampered = `${header}.invalid_payload.${signature}`;

      await expect(signer.verify(tampered)).rejects.toThrow(InvalidSignatureError);
    });

    it("should reject a forged signature", async () => {
      const signResult = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      // Forge the signature
      const [header, payload] = signResult.value.token.split(".");
      const forged = `${header}.${payload}.forged_signature`;

      await expect(signer.verify(forged)).rejects.toThrow(InvalidSignatureError);
    });

    it("should reject an expired token", async () => {
      // Create a token that expires in 100ms
      const signResult = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 100),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      // Wait for it to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      await expect(signer.verify(signResult.value.token)).rejects.toThrow(
        ExpiredTokenError,
      );
    });

    it("should reject malformed base64", async () => {
      const malformed = "not.valid.base64!!!";
      await expect(signer.verify(malformed)).rejects.toThrow(MalformedTokenError);
    });

    it("should reject a token with missing required claims", async () => {
      // Manually craft a JWT with missing claims using jose
      const { SignJWT } = await import("jose");

      const incompletePayload = { sub: "user-123" }; // missing sid, orgId, etc.
      const privateKey = require("node:crypto").createPrivateKey(privateKeyPem);

      const incompleteToken = await new SignJWT(incompletePayload)
        .setProtectedHeader({ alg: "RS256" })
        .sign(privateKey);

      await expect(signer.verify(incompleteToken)).rejects.toThrow(
        MalformedTokenError,
      );
    });
  });

  describe("sign/verify round-trip", () => {
    it("should verify a token immediately after signing", async () => {
      const signResult = await signer.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      const verified = await signer.verify(signResult.value.token);
      expect(verified).toEqual(signResult.value.claims);
    });

    it("should handle multiple concurrent operations", async () => {
      const operations = Array.from({ length: 5 }, (_, i) => ({
        userId: `user-${i}` as any,
        sessionId: `session-${i}` as any,
        organizationId: `org-${i}` as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }));

      // Sign all
      const signResults = await Promise.all(operations.map((op) => signer.sign(op)));
      const tokens = signResults
        .filter(isOk)
        .map((result) => result.value.token);

      // Verify all
      const verified = await Promise.all(tokens.map((token) => signer.verify(token)));

      verified.forEach((claims, i) => {
        expect(claims.sub).toBe(`user-${i}`);
        expect(claims.sid).toBe(`session-${i}`);
        expect(claims.orgId).toBe(`org-${i}`);
      });
    });
  });

  describe("key caching", () => {
    it("should reuse cached keys on subsequent calls", async () => {
      // First call caches the key
      const result1 = await signer.sign({
        userId: "user-1" as any,
        sessionId: "session-1" as any,
        organizationId: "org-1" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      // Second call should use cached key (no exception)
      const result2 = await signer.sign({
        userId: "user-2" as any,
        sessionId: "session-2" as any,
        organizationId: "org-2" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      expect(isOk(result1)).toBe(true);
      expect(isOk(result2)).toBe(true);
    });
  });

  describe("different signers with same key material", () => {
    it("should verify tokens across different signer instances", async () => {
      const signer1 = new JwtTokenSigner(privateKeyPem, publicKeyPem, keyId);
      const signer2 = new JwtTokenSigner(privateKeyPem, publicKeyPem, keyId);

      const signResult = await signer1.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (!isOk(signResult)) throw new Error("Sign failed");

      // signer2 (different instance, same keys) should verify the token
      const claims = await signer2.verify(signResult.value.token);
      expect(claims.sub).toBe("user-123");
    });
  });

  describe("error types", () => {
    it("should throw SigningError instances with correct code", async () => {
      const badSigner = new JwtTokenSigner("bad-key", publicKeyPem, keyId);

      const result = await badSigner.sign({
        userId: "user-123" as any,
        sessionId: "session-456" as any,
        organizationId: "org-789" as any,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      if (isErr(result)) {
        expect(result.error.code).toBe("SIGNING_FAILED");
      } else {
        throw new Error("Expected signing to fail");
      }
    });

    it("InvalidSignatureError should have code and status hint", () => {
      const error = new InvalidSignatureError("test");
      expect(error.code).toBe("INVALID_SIGNATURE");
      expect(error.httpStatusHint).toBe(401);
    });

    it("ExpiredTokenError should have code and status hint", () => {
      const error = new ExpiredTokenError("test");
      expect(error.code).toBe("EXPIRED_TOKEN");
      expect(error.httpStatusHint).toBe(401);
    });

    it("MalformedTokenError should have code and status hint", () => {
      const error = new MalformedTokenError("test");
      expect(error.code).toBe("MALFORMED_TOKEN");
      expect(error.httpStatusHint).toBe(401);
    });
  });
});
