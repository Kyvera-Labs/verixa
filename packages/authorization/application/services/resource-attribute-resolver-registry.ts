import type {
  ResourceAttributeResolver,
  ResourceAttributes,
} from "../ports/resource-attribute-resolver.js";

/**
 * Thrown when no resolver is registered for a resource type. A missing resolver is a wiring bug,
 * and failing loudly avoids evaluating a policy against an empty attribute set.
 */
export class UnknownResourceTypeError extends Error {
  readonly resourceType: string;

  constructor(resourceType: string) {
    super(`No resource-attribute resolver is registered for resource type "${resourceType}".`);
    this.name = "UnknownResourceTypeError";
    this.resourceType = resourceType;
  }
}

/**
 * Maps resource types (`"document"`, `"verificationCase"`,...) to the {@link
 * ResourceAttributeResolver} that fetches their attributes. Other contexts register resolvers from
 * their composition roots, so supporting a new resource type needs no change here or in the engine.
 */
export class ResourceAttributeResolverRegistry {
  private readonly resolversByResourceType = new Map<string, ResourceAttributeResolver>();

  /**
   * Registers `resolver` for `resourceType`, replacing any resolver already
   * registered for it. Overwriting rather than throwing on a duplicate
   * registration is deliberate: composition-root wiring runs
   * once at process startup in a fixed, known order, so a second
   * registration for the same resource type is far more likely to be an
   * intentional override (e.g. test setup replacing a real resolver with a
   * fake) than a bug worth failing startup over.
   */
  register(resourceType: string, resolver: ResourceAttributeResolver): void {
    this.resolversByResourceType.set(resourceType, resolver);
  }

  /** Whether a resolver is currently registered for `resourceType`. */
  has(resourceType: string): boolean {
    return this.resolversByResourceType.has(resourceType);
  }

  /**
   * Resolves `resourceId`'s attributes using the resolver registered for
   * `resourceType`.
   *
   * @throws {UnknownResourceTypeError} if no resolver is registered for
   * `resourceType`.
   */
  async resolve(resourceType: string, resourceId: string): Promise<ResourceAttributes> {
    const resolver = this.resolversByResourceType.get(resourceType);
    if (resolver === undefined) {
      throw new UnknownResourceTypeError(resourceType);
    }
    return resolver.resolve(resourceId);
  }
}
