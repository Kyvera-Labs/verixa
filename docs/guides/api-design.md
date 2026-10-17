# API design

## Request schemas and OpenAPI

Define each request DTO once as a Zod schema and register it with
`registerZodSchema` from `apps/api/src/openapi/zod-registry.ts`. The helper
converts that schema to JSON Schema, registers it with Fastify for request
validation, and retains the same component for OpenAPI generation. Route
options reference the registered component (`{ $ref: "CreateWidgetBody#" }`)
instead of repeating a handwritten JSON Schema.

This keeps runtime acceptance rules and published API documentation together.
Maintaining separate Zod and JSON Schema definitions is tempting because it
looks explicit at each call site, but duplicated constraints drift as routes
change. The route registration guard makes an inline or unknown request schema
fail during app setup, so CI catches the mismatch before deployment.

Use shape constraints at the HTTP boundary. Rules that depend on domain state
or business policy stay in the application or domain layer.

## Error responses

Errors should use the shared API error envelope and stable error codes. Do not
return stack traces or internal exception messages to clients. See
`apps/api/src/http/error-response.ts` for the transport boundary.
# API Design

The REST API is a transport boundary around application use cases. Routes parse HTTP input, call a use case, and translate its result into an HTTP response. They do not own business rules or data access.

## Error response contract

Every API error uses this shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {
      "fields": {
        "body.email": ["must be a valid email"]
      }
    },
    "requestId": "req-..."
  }
}
```

`details` is optional and carries structured, client-actionable information. Request validation uses `details.fields`; other failures omit details unless the API defines a similarly safe structure. `requestId` is always present and matches the identifier in server logs, so a client can report a failure without receiving stack traces, SQL details, or other internal data.

The `code` comes from the explicit registry in `apps/api/src/http/error-code-registry.ts`. Clients may branch on this stable value; they should not branch on `message`, which is written for people and may be clarified. Domain errors are mapped through that registry. Unknown exceptions are logged with their request context and returned as a sanitized `INTERNAL_ERROR`.

Common codes include `VALIDATION_ERROR` (400), `AUTHENTICATION_FAILED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), and `INTERNAL_ERROR` (500). Domain-specific failures keep their registered code and status rather than being collapsed into one generic response.

The API uses one global Fastify error handler instead of per-route `try/catch` mappings. This ensures framework errors, validation failures, and uncaught exceptions share the same response shape. Keeping domain-to-HTTP mappings in one table also makes adding a new domain failure an explicit API decision rather than an accidental result of a generic catch-all.

The response schema is exported as `ErrorResponse` for reuse as the shared OpenAPI component. It intentionally describes the common envelope; operation-specific responses can reference it without redefining the envelope or drifting on required fields.
## Request validation

Routes declare schemas for every accepted body, path parameter, and query
parameter. Fastify validates these inputs before it calls the handler, so bad
requests cannot reach a use case. Keep schemas at the HTTP boundary: they
validate request shape, while domain and application layers enforce business
rules.

The API registers a route guard during app construction. It rejects write
routes without a body schema, parameterized paths without a params schema, and
the assignment listing route without its query schema. This makes missing
validation fail during CI app setup instead of allowing an unvalidated route
to ship. Validation failures use the shared `VALIDATION_ERROR` response with
field-level details.
# API Design: contract before routes

`apps/api/openapi/openapi.yaml` is the source of truth for the REST API
contract. Define the operation, request/response schemas, error shape, and
security requirements there before implementing its route. This lets client
work and server work agree on observable behavior before either depends on
implementation details.

The current document reserves tags for Identity, Credentials, Sessions, MFA,
Authorization, Verification, Audit, Governance, and Notifications. Its empty
`paths` object is intentional: the API contract is introduced before this
phase's route catalogue. Add an operation under its bounded-context tag in
the same change that exposes it; do not invent an undocumented route as a
shortcut.

## Local documentation

In development, `@fastify/swagger` loads the static OpenAPI document and
`@fastify/swagger-ui` serves an interactive viewer at `/docs/`. The canonical
JSON document is available at `/docs/openapi.json`. These development routes
are disabled when `NODE_ENV=production`; publish or protect API documentation
as an explicit deployment decision rather than exposing it accidentally.

CI validates the YAML against OpenAPI using Redocly CLI. A change that parses
as YAML but violates the OpenAPI schema must not merge.

## Adding an operation

1. Add the operation and shared schema references to `openapi.yaml`.
2. Give it a bounded-context tag and document success and failure responses.
3. Implement request shape validation in the Fastify route, then delegate
   business rules to the application use case.
4. Keep authorization checks server-side; CORS and the OpenAPI document do
   not grant or deny access.
5. Add the route-registration wiring in `apps/api` and verify the contract
   against the behavior before merge.

The contract does not try to describe internal persistence details. That
boundary keeps clients stable when adapters change and makes compatibility
review a question about requests and responses, not the database schema.
