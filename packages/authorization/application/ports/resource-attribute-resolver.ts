/**
 * An attribute value a resolver may return. Restricted to JSON-serializable
 * primitives and arrays of them for the same reason `ComparisonLiteral` is
 * (see `domain/value-objects/condition.ts`) — resource attributes ultimately
 * feed comparisons in a `Condition` tree, so their shape has to line up with
 * what a comparison can hold.
 */
export type ResourceAttributeValue = string | number | boolean | readonly (string | number)[];

/** The attributes a resolver fetched for one resource instance (owner, org, sensitivity label, status, ...). */
export type ResourceAttributes = Readonly<Record<string, ResourceAttributeValue>>;

/**
 * Implemented by a bounded context so ABAC policies can condition on its resources' attributes. The
 * owning context registers an instance with the `ResourceAttributeResolverRegistry`, so this
 * package never depends on other contexts' schemas; `resolve` takes a bare `resourceId` for the
 * same reason.
 */
export interface ResourceAttributeResolver {
  resolve(resourceId: string): Promise<ResourceAttributes>;
}
