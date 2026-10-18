import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { registerCors } from "./cors.js";
import { handleApiError } from "../http/error-response.js";

describe("registerCors", () => {
  it("allows cross-origin requests from allow-listed origins with credentials", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.get("/test", async () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .get("/test")
      .set("Origin", "https://trusted.verixa.io");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://trusted.verixa.io");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");

    await app.close();
  });

  it("rejects cross-origin requests from non-allow-listed origins", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.get("/test", async () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .get("/test")
      .set("Origin", "https://evil-attacker.com");

    expect(response.status).not.toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("handles preflight OPTIONS requests for allowed origins", async () => {
    const app = Fastify();
    app.setErrorHandler(handleApiError);
    registerCors(app, {
      allowedOrigins: ["https://trusted.verixa.io"],
      allowCredentials: true,
    });

    app.post("/test", async () => ({ status: "ok" }));
    await app.ready();

    const response = await supertest(app.server)
      .options("/test")
      .set("Origin", "https://trusted.verixa.io")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type,Authorization");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://trusted.verixa.io");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");

    await app.close();
  });
});
