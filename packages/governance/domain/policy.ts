import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

export type PolicyId = Id<"PolicyId">;
export type OrganizationId = Id<"OrganizationId">;
export type PolicyStatus = "draft" | "published" | "archived";
export type Ruleset = Readonly<Record<string, unknown>>;

/** Freezes a cloned ruleset all the way down, so a published snapshot cannot change. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export class PolicyVersion {
  readonly version: number;
  readonly ruleset: Ruleset;
  readonly publishedAt: Date;
  constructor(version: number, ruleset: Ruleset, publishedAt = new Date()) {
    this.version = version;
    this.ruleset = deepFreeze(structuredClone(ruleset));
    this.publishedAt = publishedAt;
  }
}

interface PolicyProps {
  readonly id: PolicyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: PolicyStatus;
  readonly version: number;
  readonly ruleset: Ruleset;
  readonly history: readonly PolicyVersion[];
}

export class Policy {
  readonly id: PolicyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: PolicyStatus;
  readonly version: number;
  readonly ruleset: Ruleset;
  private readonly history: readonly PolicyVersion[];

  private constructor(props: PolicyProps) {
    this.id = props.id;
    this.organizationId = props.organizationId;
    this.name = props.name;
    this.status = props.status;
    this.version = props.version;
    this.ruleset = structuredClone(props.ruleset);
    this.history = props.history;
  }

  private props(): PolicyProps {
    return {
      id: this.id,
      organizationId: this.organizationId,
      name: this.name,
      status: this.status,
      version: this.version,
      ruleset: this.ruleset,
      history: this.history,
    };
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
    if (this.status !== "draft") {
      return Result.err(new ValidationError("Only draft policies can be edited."));
    }
    return Result.ok(new Policy({ ...this.props(), ruleset }));
  }

  publish(): Result<Policy, ValidationError> {
    if (this.status !== "draft") {
      return Result.err(new ValidationError("Only draft policies can be published."));
    }
    const snapshot = new PolicyVersion(this.version + 1, this.ruleset);
    return Result.ok(
      new Policy({
        ...this.props(),
        status: "published",
        version: snapshot.version,
        history: [...this.history, snapshot],
      }),
    );
  }

  /**
   * Starts a new draft from a published policy. The published snapshots stay
   * in the history untouched; the next publish appends a new version.
   */
  revise(): Result<Policy, ValidationError> {
    if (this.status !== "published") {
      return Result.err(new ValidationError("Only published policies can be revised."));
    }
    return Result.ok(new Policy({ ...this.props(), status: "draft" }));
  }

  archive(): Result<Policy, ValidationError> {
    if (this.status !== "published") {
      return Result.err(new ValidationError("Only published policies can be archived."));
    }
    return Result.ok(new Policy({ ...this.props(), status: "archived" }));
  }

  versions(): readonly PolicyVersion[] {
    return this.history.map((v) => new PolicyVersion(v.version, v.ruleset, v.publishedAt));
  }
}
