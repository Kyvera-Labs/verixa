import { describe, expect, it } from "vitest";

import { auditFilters, QueryParamsBuilder, sortParams } from "./filters.js";

describe("auditFilters", () => {
  it("emits only the filter names documented for GET /v1/audit", () => {
    const params = auditFilters()
      .actorId("usr_1")
      .subjectId("org_1")
      .from("2026-01-01T00:00:00.000Z")
      .to("2026-02-01T00:00:00.000Z")
      .build();

    expect(params).toEqual({
      actorId: "usr_1",
      subjectId: "org_1",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
  });

  it("serializes Date bounds as ISO 8601 strings", () => {
    const params = auditFilters().from(new Date("2026-03-04T05:06:07.000Z")).build();

    expect(params).toEqual({ from: "2026-03-04T05:06:07.000Z" });
  });

  it("omits unset and blank values so they never become query params", () => {
    const params = auditFilters().actorId(undefined).subjectId("").from(null).build();

    expect(params).toEqual({});
  });
});

describe("QueryParamsBuilder", () => {
  it("serializes scalar values using their string form", () => {
    const params = new QueryParamsBuilder().with("limit", 25).with("active", true).build();

    expect(params).toEqual({ limit: "25", active: "true" });
  });

  it("builds search params for transports that accept URLSearchParams", () => {
    const search = new QueryParamsBuilder().with("cursor", "next page").toSearchParams();

    expect(search.get("cursor")).toBe("next page");
  });
});

describe("sortParams", () => {
  it("uses the parameter names supplied by the resource contract", () => {
    const params = sortParams(
      { field: "occurredAt", direction: "desc" },
      { field: "sort", direction: "order" },
    );

    expect(params).toEqual({ sort: "occurredAt", order: "desc" });
  });

  it("defaults an unspecified direction to ascending", () => {
    expect(sortParams({ field: "createdAt" })).toEqual({
      sortBy: "createdAt",
      sortOrder: "asc",
    });
  });

  it("returns no params when sorting is absent", () => {
    expect(sortParams(undefined)).toEqual({});
  });
});
