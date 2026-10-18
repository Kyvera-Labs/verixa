import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import OpenApiResponseValidator from "openapi-response-validator";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ResponseValidatorInstance {
  validateResponse(status: number, body: unknown): { errors: unknown[] } | undefined;
}
type ResponseValidatorClass = new (options: {
  responses: unknown;
  components: unknown;
}) => ResponseValidatorInstance;

// The package is CommonJS; depending on interop the class arrives as the module or as `.default`.
const interop = OpenApiResponseValidator as unknown as ResponseValidatorClass & {
  default?: ResponseValidatorClass;
};
const ResponseValidator: ResponseValidatorClass = interop.default ?? interop;

interface OpenApiDocument {
  openapi: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
}

describe("OpenAPI Contract Validation", () => {
  const specPath = fileURLToPath(new URL("../../openapi/openapi.yaml", import.meta.url));
  // A fixed file in this package, not caller input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const rawSpec = readFileSync(specPath, "utf-8");
  const spec = parse(rawSpec) as OpenApiDocument;

  it("loads and parses the OpenAPI specification", () => {
    expect(spec).toBeDefined();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.components?.schemas).toBeDefined();
  });

  const fixtures = [
    {
      context: "Health",
      method: "GET",
      path: "/health",
      status: 200,
      responseBody: { status: "ok" },
      responsesDefinition: {
        200: {
          description: "Health status",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["HealthResponse"],
            },
          },
        },
      },
    },
    {
      context: "Identity & Credentials",
      method: "POST",
      path: "/auth/register",
      status: 400,
      responseBody: {
        error: "validation_error",
        message: "Invalid request payload",
        fields: { email: ["Invalid email format"] },
      },
      responsesDefinition: {
        400: {
          description: "Bad Request",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["ValidationError"],
            },
          },
        },
      },
    },
    {
      context: "Sessions & Authentication",
      method: "POST",
      path: "/auth/login",
      status: 401,
      responseBody: {
        error: "AUTHENTICATION_FAILED",
        message: "Invalid email or password.",
      },
      responsesDefinition: {
        401: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["ErrorResponse"],
            },
          },
        },
      },
    },
    {
      context: "Authorization",
      method: "GET",
      path: "/admin/roles",
      status: 403,
      responseBody: {
        error: "FORBIDDEN",
        message: "Insufficient permissions to list roles",
      },
      responsesDefinition: {
        403: {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["ErrorResponse"],
            },
          },
        },
      },
    },
    {
      context: "Verification",
      method: "GET",
      path: "/verification/req_123",
      status: 404,
      responseBody: {
        error: "NOT_FOUND",
        message: "Verification request not found",
      },
      responsesDefinition: {
        404: {
          description: "Not Found",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["ErrorResponse"],
            },
          },
        },
      },
    },
  ];

  for (const fixture of fixtures) {
    it(`validates ${fixture.context} fixture response against OpenAPI schema for ${fixture.method} ${fixture.path}`, () => {
      const validator = new ResponseValidator({
        responses: fixture.responsesDefinition,
        components: spec.components,
      });

      const validationError = validator.validateResponse(fixture.status, fixture.responseBody);
      expect(validationError).toBeUndefined();
    });
  }

  it("fails validation when a response diverges from the OpenAPI schema", () => {
    const validator = new ResponseValidator({
      responses: {
        200: {
          description: "Health status",
          content: {
            "application/json": {
              schema: spec.components?.schemas?.["HealthResponse"],
            },
          },
        },
      },
      components: spec.components,
    });

    // HealthResponse requires status: "ok" and additionalProperties: false
    const divergingResponse = { status: "unknown", extraProperty: 123 };
    const validationError = validator.validateResponse(200, divergingResponse);
    expect(validationError).toBeDefined();
    expect(validationError?.errors.length).toBeGreaterThan(0);
  });
});
