import { describe, expect, it } from "vitest";

import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

/**
 * `/.well-known/security.txt` (Issue 211).
 *
 * The assertions here are about RFC 9116 conformance rather than about the
 * wording of the policy: this file's only job is to be *parsed by a stranger's
 * tooling*, and a security.txt that a scanner cannot read is a channel that
 * does not exist. Prose lives in `SECURITY.md`.
 */

/** RFC 9116 section 3: `field-name ":" sp field-value LF`, LF terminated. */
const FIELD_LINE = /^(?<name>[A-Za-z][A-Za-z-]*): (?<value>.*)$/;

/** RFC 3339 / RFC 9116 timestamps carry no fractional seconds and end in `Z`. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

function parseField(line: string): { name: string; value: string } | null {
  const groups = FIELD_LINE.exec(line)?.groups;
  const name = groups?.["name"];
  const value = groups?.["value"];
  if (name === undefined || value === undefined) return null;
  return { name, value };
}

function parseFields(body: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();

  for (const line of body.split("\n")) {
    if (line === "") continue;
    const field = parseField(line);
    if (field === null) {
      // A line that is not a field is not a security.txt — a stray log line,
      // an HTML error page serialized, a blank-with-spaces artefact.
      throw new Error(`line is not an RFC 9116 field: ${JSON.stringify(line)}`);
    }
    fields.set(field.name, [...(fields.get(field.name) ?? []), field.value]);
  }

  return fields;
}

async function withClient<T>(run: (client: HttpTestClient) => Promise<T>): Promise<T> {
  const client = await createHttpTestClient();
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

describe("GET /.well-known/security.txt", () => {
  it("serves plain text, not the JSON every other route returns", async () => {
    await withClient(async (client) => {
      const response = await client.request.get("/.well-known/security.txt");

      expect(response.status).toBe(200);
      // Fastify appends a boundary or charset of its own for some media
      // types; the RFC's requirement is the type, and a reader must not have
      // to guess the character encoding.
      expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    });
  });

  it("answers with the required Contact field, as a URL", async () => {
    await withClient(async (client) => {
      const response = await client.request.get("/.well-known/security.txt");
      const fields = parseFields(response.text);

      const contact = fields.get("Contact");
      expect(contact).toBeDefined();
      expect(contact?.length).toBeGreaterThan(0);
      // Private advisories rather than a mailbox — see SECURITY.md.
      expect(contact?.[0]).toBe("https://github.com/Kyvera-Labs/verixa/security/advisories/new");
      for (const value of contact ?? []) {
        expect(value).toMatch(/^https:\/\//);
      }
    });
  });

  it("carries an Expires the reader can act on: valid format, in the future", async () => {
    await withClient(async (client) => {
      const response = await client.request.get("/.well-known/security.txt");
      const fields = parseFields(response.text);

      const expires = fields.get("Expires")?.[0];
      expect(expires).toBeDefined();
      // `.000Z` from `toISOString()` is rejected by a strict reader, and so is
      // a `+00:00` offset in this field.
      expect(expires).toMatch(TIMESTAMP);

      const when = Date.parse(expires ?? "");
      expect(Number.isNaN(when)).toBe(false);
      expect(when).toBeGreaterThan(Date.now());
    });
  });

  it("declares the language it is written in", async () => {
    await withClient(async (client) => {
      const response = await client.request.get("/.well-known/security.txt");
      const fields = parseFields(response.text);

      expect(fields.get("Preferred-Languages")?.[0]).toBe("en");
      expect(fields.get("Policy")?.[0]).toBe(
        "https://github.com/Kyvera-Labs/verixa/blob/master/SECURITY.md",
      );
    });
  });

  it("terminates the final line", async () => {
    await withClient(async (client) => {
      const response = await client.request.get("/.well-known/security.txt");

      // A saved copy of the file must parse as a complete record; a body whose
      // last field has no line ending is the kind of detail that only bites
      // the person who copies it into a report.
      expect(response.text.endsWith("\n")).toBe(true);
      expect(response.text.at(-2)).not.toBe("\n");

      // Supertest sends a well-formed Host, so all five fields are present.
      expect([...parseFields(response.text).keys()].sort()).toEqual(
        ["Canonical", "Contact", "Expires", "Policy", "Preferred-Languages"].sort(),
      );
    });
  });

  it("reflects a well-formed Host header into Canonical", async () => {
    await withClient(async (client) => {
      const response = await client.request
        .get("/.well-known/security.txt")
        .set("Host", "security.example.org");

      const fields = parseFields(response.text);
      expect(fields.get("Canonical")?.[0]).toBe(
        "https://security.example.org/.well-known/security.txt",
      );
    });
  });

  it("refuses to build a Canonical line out of a malformed Host header", async () => {
    await withClient(async (client) => {
      // Host is the one field this document takes from the request. A value
      // that is not a host would otherwise be written straight into a
      // machine-readable security contact — letting a crafted request make
      // this file advertise some other address, or invent extra fields.
      const response = await client.request
        .get("/.well-known/security.txt")
        .set("Host", "example.org/redirect?Contact=https://attacker.example");

      expect(response.status).toBe(200);
      const fields = parseFields(response.text);
      expect(fields.has("Canonical")).toBe(false);
      // Exactly one Contact, and it is still ours.
      expect(fields.get("Contact")).toHaveLength(1);
    });
  });

  it("is reachable on a process with no database wired at all", async () => {
    // Every client above was built without a container, which is the point:
    // the disclosure channel must not depend on the database being up. This
    // spells it out because the same `buildApp` call 404s for `/auth/login`.
    await withClient(async (client) => {
      const security = await client.request.get("/.well-known/security.txt");
      const login = await client.request.post("/auth/login").send({});

      expect(security.status).toBe(200);
      expect(login.status).toBe(404);
    });
  });
});
