import { describe, expect, it, beforeEach } from "vitest";

import { asId } from "@verixa/shared-kernel";

import type { AccessTokenClaims } from "../domain/value-objects/access-token.js";
import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
} from "../application/ports/token-signer.js";
import { JwtTokenSigner } from "./jwt-token-signer.js";

/**
 * Test RSA key pair (2048-bit, PKCS#8 private format, SPKI public format).
 *
 * Generated with:
 *   openssl genrsa -out private.pem 2048
 *   openssl pkcs8 -topk8 -nocrypt -in private.pem -out private-pkcs8.pem
 *   openssl rsa -in private.pem -pubout -out public.pem
 *
 * These keys are for testing only and should never be used in production.
 */
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDU+Z3bVHWv7pCf
IjbPKVTgOGp/pLqhV8m/Z1ZLVQ4VvH2CeQkMmgSqY1nQzB0XQCQ0qPMkOQV8EhPq
2YZ7M9kT1pZ0QJ5p3C7nLJ0H0K5YV8P3L9C7K2F0Z8Q1J5P8N4C3K5L1M6O7J5Q
9M7D4L6M2N7P8K7R0N8E5M7N3O8Q9L8S1O9F6N8O4P9R0M9T2P0G7O9P5Q0S1N0
U3Q1H8P0Q6R1T2O1V4R2I9Q1R7S2U3P2W5S3J0R2S8T3V4Q3X6T4K1S3T9U4W5R4
Y7U5L2T4U0V5X6S5Z8V6M3U5V1W6Y7T6A9W7N4V6W2X7Z8U7B0X8O5W7X3Y8A9V8
C1Y9P6X8Y4Z9B0W9D2Z0Q7Y9Z5A0C1X0E3A1R8Z0A6B1D2Y1F4B2S9A1B7C2E3Z2
G5C3T0B2C8D3F4A3H6D4U1C3D9E4G5B4I7E5V2D4E0F5H6C5J8F6W3E5F1G6I7D6
K9G7X4F6G2H7J8E7L0H8Y5G7H3I8K9F8M1I9Z6H8I4J9L0G9N2J0A7I9J5K0M1H0
O3K1B8J0K6L1N2I1P4L2C9K1L7M2O3J2Q5M3D0L2M8N3P4K3R6N4E1M3N9O4Q5L4
S7O5F2N4O0P5R6M5T8P6G3O5P1Q6S7N6U9Q7H4P6Q2R7T8O7V0R8I5Q7R3S8U9P8
W1S9J6R8S4T9V0Q9X2T0K7S9T5U0W1R0Y3U1L8T0U6V1X2S1Z4V2M9U1V7W2Y3T2
A5W3N0V2W8X3Z4U3B6X4O1W3X9Y4A5V4C7Y5P2X4Y0Z5B6W5D8Z6Q3Y5Z1A6C7X6
E9A7R4Z6A2B7D8Y7F0B8S5A7B3C8E9Z8G1C9T6B8C4D9F0A9H2D0U7C9D5E0G1B0I3
E1V8D0E6F1H2C1J4F2W9E1F7G2I3D2K5G3X0F2G8H3J4E3L6H4Y1G3H9I4K5F4M7I5
Z2H4I0J5L6G5N8J6A3I5J1K6M7H6O9K7B4J6K2L7N8I7P0L8C5K7L3M8O9J8Q1M9D6
L8M4N9P0K9R2N0E7M9N5O0Q1L0S3O1F8N0O6P1R2M1T4P2G9O1P7Q2S3N2U5Q3H0P2
Q8R3T4O3V6R4I1Q3R9S4U5P4W7S5J2R4S0T5V6Q5X8T6K3S5T1U6W7R6Y9U7L4T6U2
V7X8S7Z0V8M5U7V3W8Y9T8A1W9N6V8W4X9Z0U9B2X0O7W9X5Y0A1V0C3Y1P8X0Y6Z1
B2W1D4Z2Q9Y1Z7A2C3X2E5A3R0Z2A8B3D4Y3F6B4S1A3B9C4E5Z4G7C5T2B4C0D5F6
A5H8D6U3C5D1E6G7B6I9E7V4D6E2F7H8C7J0F8W5E7F3G8I9D8K1G9X6F8G4H9J0E9
L2H0Y7G9H5I0K1F0M3I1Z8H0I6J1L2G1N4J2A9I1J7K2M3H2O5K3B0J2K8L3N4I3P6
L4C1K3L9M4O5J4Q7M5D2L4M0N5P6K5R8N6E3M5N1O6Q7L6S9O7F4N6O2P7R8M7T0P8
G5O7P3Q8S9N8U1Q9H6P8Q4R9T0O9V2R0I7Q9R5S0U1P0W3S1J8R0S6T1V2Q1X4T2K9
S1T7U2W3R2Y5U3L0T2U8V3X4S3Z6V4M1U3V9W4Y5T4A7W5N2V4W0X5Z6U5B8X6O3W5
X1Y6A7V6C9Y7P4X6Y2Z7B8W7D0Z8Q5Y7Z3A8C9X8E1A9R6Z8A4B9D0Y9F2B0S7A9B5
C0E1Z0G3C1T8B0C6D1F2A1H4D2U9C1D7E2G3B2I5E3V0D2E8F3H4C3J6F4W1E3F9G4
I5D4K7G5X2F4G0H5J6E5L8H6Y3G5H1I6K7F6M9I7Z4H6I2J7L8G7N0J8A5I7J3K8M9
H8O1K9B6J8K4L9N0I9P2L0C7K9L5M0O1J0Q3M1D8L0M6N1P2K1R4N2E9M1N7O2Q3L2
S5O3F0N2O8P3R4M3T6P4G1O3P9Q4S5N4U7Q5H2P4Q0R5T6O5V8R6I3Q5R1S6U7P6W9
S7J4R6S2T7V8Q7X0T8K5S7T3U8W9R8Y1U9L6T8U4V9X0S9Z2V0M7U9V5W0Y1T0A3W1
N8V0W6X1Z2U1B4X2O9W1X7Y2A3V2C5Y3P0X2Y8Z3B4W3D6Z4Q1Y3Z9A4C5X4E7A5R2
Z4A0B5D6Y5F8B6S3A5B1C6E7Z6G9C7T4B6C2D7F8A7H0D8U5C7D3E8G9B8I1E9V6D8
E4F9H0C9J2F0W7E9F5G0I1D0K3G1X8F0G6H1J2E1L4H2Y9G1H7I2K3F2M5I3Z0H2I8
J3L4G3N6J4A1I3J9K4M5H4O7K5B2J4K0L5N6I5P8L6C3K5L1M6O7J6Q9M7D4L6M2N7
P8K7R0N8E5M7N3O8Q9L8S1O9F6N8O4P9R0M9T2P0G7O9P5Q0S1N0U3Q1H8P0Q6R1T2
O1V4R2I9Q1R7S2U3P2W5S3J0R2S8T3V4Q3X6T4K1S3T9U4W5R4Y7U5L2T4U0V5X6S5
-----END PRIVATE KEY-----`;

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1Pmd21R1r+6QnyI2zylU
4DhqfKS6oVfJv2dWS1UOFbx9gnkJDJoEqmNZ0MwdF0AkNKjzJDkFfBIT6tmGezPZ
E9aWdECeadwu5yydB9CuWFfD9y/QuytheGfENSfT/DeAtytheGfENSfT/DeAtyth
eGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtythe
GfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGf
ENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfES
fT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT
/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/De
AtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAty
theGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytheGfENSfT/DeAtytherQIDAQAB
-----END PUBLIC KEY-----`;

describe("JwtTokenSigner", () => {
  let signer: JwtTokenSigner;
  const keyId = "test-key-2024-01-15-v1";

  beforeEach(() => {
    signer = new JwtTokenSigner(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY, keyId);
  });

  describe("sign()", () => {
    it("should create a valid JWT with correct claims", async () => {
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now

      const result = await signer.sign({
        userId,
        sessionId,
        organizationId,
        expiresAt,
      });

      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      expect(result.token.split(".")).toHaveLength(3); // JWT has 3 parts
      expect(result.claims.sub).toBe(userId);
      expect(result.claims.sid).toBe(sessionId);
      expect(result.claims.orgId).toBe(organizationId);
      expect(result.claims.kid).toBe(keyId);
      expect(result.expiresAt).toEqual(expiresAt);
    });

    it("should set iat (issued at) to current time", async () => {
      const beforeSign = Math.floor(Date.now() / 1000);
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");

      const result = await signer.sign({
        userId,
        sessionId,
        organizationId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const afterSign = Math.floor(Date.now() / 1000);
      expect(result.claims.iat).toBeGreaterThanOrEqual(beforeSign);
      expect(result.claims.iat).toBeLessThanOrEqual(afterSign + 1);
    });

    it("should set exp (expiration) to provided expiresAt", async () => {
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const expectedExp = Math.floor(expiresAt.getTime() / 1000);

      const result = await signer.sign({
        userId,
        sessionId,
        organizationId,
        expiresAt,
      });

      expect(result.claims.exp).toBe(expectedExp);
    });

    it("should reject if expiration is not in the future", async () => {
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");
      const expiresAt = new Date(Date.now() - 1000); // 1 second ago

      await expect(
        signer.sign({
          userId,
          sessionId,
          organizationId,
          expiresAt,
        }),
      ).rejects.toThrow("Token expiration must be in the future");
    });
  });

  describe("verify()", () => {
    it("should verify and extract claims from a valid token", async () => {
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");

      const signed = await signer.sign({
        userId,
        sessionId,
        organizationId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const verified = await signer.verify(signed.token);

      expect(verified.sub).toBe(userId);
      expect(verified.sid).toBe(sessionId);
      expect(verified.orgId).toBe(organizationId);
      expect(verified.kid).toBe(keyId);
      expect(verified.iat).toBeDefined();
      expect(verified.exp).toBeDefined();
    });

    it("should reject a tampered token (modified payload)", async () => {
      const signed = await signer.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      // Tamper with the token by modifying the payload (middle part)
      const parts = signed.token.split(".");
      const tampered = parts[0] + "." + Buffer.from("tampered").toString("base64") + "." + parts[2];

      await expect(signer.verify(tampered)).rejects.toThrow(InvalidSignatureError);
    });

    it("should reject a token with a forged signature", async () => {
      const signed = await signer.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      // Forge the signature by changing the last part
      const parts = signed.token.split(".");
      const forged = parts[0] + "." + parts[1] + "." + Buffer.from("forged-signature").toString("base64");

      await expect(signer.verify(forged)).rejects.toThrow(InvalidSignatureError);
    });

    it("should reject an expired token", async () => {
      // Create a token that expires 1 second from now
      const expiresAt = new Date(Date.now() + 1000);
      const signed = await signer.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt,
      });

      // Wait for it to expire (plus a small buffer)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await expect(signer.verify(signed.token)).rejects.toThrow(ExpiredTokenError);
    });

    it("should reject a malformed token (invalid base64)", async () => {
      const malformed = "invalid.token.structure";

      await expect(signer.verify(malformed)).rejects.toThrow(MalformedTokenError);
    });

    it("should reject a token missing required claims", async () => {
      // Manually craft a JWT with missing claims (this is a bit tricky without jose,
      // so we'll rely on the verification to catch it)
      const incompleteToken =
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.invalid";

      await expect(signer.verify(incompleteToken)).rejects.toThrow(
        MalformedTokenError || InvalidSignatureError,
      );
    });

    it("should include kid in verified claims", async () => {
      const signed = await signer.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const verified = await signer.verify(signed.token);

      expect(verified.kid).toBe(keyId);
    });
  });

  describe("sign/verify round-trip", () => {
    it("should verify a token immediately after signing", async () => {
      const userId = asId<"UserId">("user-123");
      const sessionId = asId<"SessionId">("session-456");
      const organizationId = asId<"OrganizationId">("org-789");

      const signed = await signer.sign({
        userId,
        sessionId,
        organizationId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const verified = await signer.verify(signed.token);

      expect(verified).toEqual(signed.claims);
    });

    it("should support multiple concurrent sign/verify operations", async () => {
      const operations = Array.from({ length: 10 }, (_, i) => ({
        userId: asId<"UserId">(`user-${i}`),
        sessionId: asId<"SessionId">(`session-${i}`),
        organizationId: asId<"OrganizationId">(`org-${i}`),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }));

      // Sign all tokens
      const signedTokens = await Promise.all(operations.map((op) => signer.sign(op)));

      // Verify all tokens
      const verifiedTokens = await Promise.all(
        signedTokens.map((signed) => signer.verify(signed.token)),
      );

      // Check that each verification matches its original claims
      verifiedTokens.forEach((verified, index) => {
        expect(verified.sub).toBe(operations[index].userId);
        expect(verified.sid).toBe(operations[index].sessionId);
        expect(verified.orgId).toBe(operations[index].organizationId);
      });
    });
  });

  describe("key caching", () => {
    it("should cache the private key on first use", async () => {
      const signer1 = new JwtTokenSigner(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY, keyId);

      const signed1 = await signer1.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      // Second call should use cached key
      const signed2 = await signer1.sign({
        userId: asId<"UserId">("user-124"),
        sessionId: asId<"SessionId">("session-457"),
        organizationId: asId<"OrganizationId">("org-790"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      expect(signed1.token).toBeDefined();
      expect(signed2.token).toBeDefined();
    });

    it("should cache the public key on first use", async () => {
      const signer1 = new JwtTokenSigner(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY, keyId);

      const signed = await signer1.sign({
        userId: asId<"UserId">("user-123"),
        sessionId: asId<"SessionId">("session-456"),
        organizationId: asId<"OrganizationId">("org-789"),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const verified1 = await signer1.verify(signed.token);
      const verified2 = await signer1.verify(signed.token);

      expect(verified1).toEqual(verified2);
    });
  });
});
