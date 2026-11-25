/** Governance snapshot shape required by the runtime authorization bridge. */
export interface OrganizationPolicy {
  readonly id: string;
  readonly organizationId: string;
  readonly status: "draft" | "published" | "archived";
  readonly version: number;
  readonly ruleset: Readonly<Record<string, unknown>>;
}

/** Supplies the latest published policies for one organization. */
export interface OrgPolicySource {
  findPublishedForOrganization(organizationId: string): Promise<readonly OrganizationPolicy[]>;
}
