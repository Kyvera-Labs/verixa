import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

export type PolicyId = Id<"PolicyId">;
export type OrganizationId = Id<"OrganizationId">;
export type PolicyStatus = "draft" | "published" | "archived";
export type Ruleset = Readonly<Record<string, unknown>>;

export class PolicyVersion {
  readonly version: number;
  readonly ruleset: Ruleset;
  readonly publishedAt: Date;
  constructor(version: number, ruleset: Ruleset, publishedAt = new Date()) {
    this.version = version;
    this.ruleset = structuredClone(ruleset);
    this.publishedAt = publishedAt;
    Object.freeze(this.ruleset);
  }
}

export class Policy {
  readonly id: PolicyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: PolicyStatus;
  readonly version: number;
  readonly ruleset: Ruleset;
  private readonly history: readonly PolicyVersion[];

  private constructor(props: {
    id: PolicyId;
    organizationId: OrganizationId;
    name: string;
    status: PolicyStatus;
    version: number;
    ruleset: Ruleset;
    history: readonly PolicyVersion[];
  }) {
    this.id = props.id;
    this.organizationId = props.organizationId;
    this.name = props.name;
    this.status = props.status;
    this.version = props.version;
    this.ruleset = structuredClone(props.ruleset);
    this.history = props.history;
  }

  static create(params: {
    organizationId: OrganizationId;
    name: string;
    ruleset: Ruleset;
  }): Result<Policy, ValidationError> {
    const name = params.name.trim();
    if (!name) return Result.err(new ValidationError("Policy name is required."));
    return Result.ok(
      new Policy({
        id: createId<"PolicyId">(),
        organizationId: params.organizationId,
        name,
        status: "draft",
        version: 0,
        ruleset: params.ruleset,
        history: [],
      }),
    );
  }
  edit(ruleset: Ruleset): Result<Policy, ValidationError> {
    if (this.status !== "draft")
      return Result.err(new ValidationError("Only draft policies can be edited."));
    return Result.ok(
      new Policy({
        id: this.id,
        organizationId: this.organizationId,
        name: this.name,
        status: this.status,
        version: this.version,
        ruleset,
        history: this.history,
      }),
    );
  }
  publish(): Result<Policy, ValidationError> {
    if (this.status !== "draft")
      return Result.err(new ValidationError("Only draft policies can be published."));
    const snapshot = new PolicyVersion(this.version + 1, this.ruleset);
    return Result.ok(
      new Policy({
        ...this,
        status: "published",
        version: snapshot.version,
        history: [...this.history, snapshot],
      }),
    );
  }
  archive(): Result<Policy, ValidationError> {
    if (this.status !== "published")
      return Result.err(new ValidationError("Only published policies can be archived."));
    return Result.ok(
      new Policy({
        id: this.id,
        organizationId: this.organizationId,
        name: this.name,
        status: "archived",
        version: this.version,
        ruleset: this.ruleset,
        history: this.history,
      }),
    );
  }
  versions(): readonly PolicyVersion[] {
    return this.history.map(
      (version) => new PolicyVersion(version.version, version.ruleset, version.publishedAt),
    );
  }
}
