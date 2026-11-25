import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Policy } from "./policy.js";

const organizationId = asId<"OrganizationId">("org_1");

function draft(ruleset: Record<string, unknown> = { maxSessions: 3 }): Policy {
  const result = Policy.create({ organizationId, name: " Sessions ", ruleset });
  if (!Result.isOk(result)) throw new Error("expected a draft");
  return result.value;
}

function unwrap(result: Result<Policy, unknown>): Policy {
  if (!Result.isOk(result)) throw new Error("expected ok");
  return result.value;
}

describe("Policy", () => {
  it("starts as an unversioned draft with a trimmed name", () => {
    const p = draft();
    expect(p.status).toBe("draft");
    expect(p.version).toBe(0);
    expect(p.name).toBe("Sessions");
  });

  it("requires a name", () => {
    expect(Result.isErr(Policy.create({ organizationId, name: "  ", ruleset: {} }))).toBe(true);
  });

  it("edits only while draft", () => {
    const edited = unwrap(draft().edit({ maxSessions: 5 }));
    expect(edited.ruleset).toEqual({ maxSessions: 5 });
    const published = unwrap(edited.publish());
    expect(Result.isErr(published.edit({ maxSessions: 9 }))).toBe(true);
  });

  it("publishing appends an immutable snapshot and bumps the version", () => {
    const published = unwrap(draft({ limits: { daily: 10 } }).publish());
    expect(published.status).toBe("published");
    expect(published.version).toBe(1);
    const [v1] = published.versions();
    expect(v1?.version).toBe(1);
    expect(Object.isFrozen(v1?.ruleset)).toBe(true);
    expect(Object.isFrozen((v1?.ruleset as { limits: object }).limits)).toBe(true);
  });

  it("revising starts a new draft and keeps the published history", () => {
    const v1 = unwrap(draft({ maxSessions: 3 }).publish());
    const revised = unwrap(v1.revise());
    expect(revised.status).toBe("draft");
    const v2 = unwrap(unwrap(revised.edit({ maxSessions: 4 })).publish());
    expect(v2.version).toBe(2);
    expect(v2.versions().map((v) => v.ruleset)).toEqual([{ maxSessions: 3 }, { maxSessions: 4 }]);
  });

  it("only revises or archives a published policy", () => {
    expect(Result.isErr(draft().revise())).toBe(true);
    expect(Result.isErr(draft().archive())).toBe(true);
    const archived = unwrap(unwrap(draft().publish()).archive());
    expect(archived.status).toBe("archived");
    expect(archived.versions()).toHaveLength(1);
  });

  it("cannot publish twice without revising", () => {
    expect(Result.isErr(unwrap(draft().publish()).publish())).toBe(true);
  });

  it("does not share the caller's ruleset object", () => {
    const rules = { maxSessions: 3 };
    const p = draft(rules);
    rules.maxSessions = 99;
    expect(p.ruleset).toEqual({ maxSessions: 3 });
  });
});
