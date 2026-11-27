/**
 * Attribute vocabulary shared by every authorization entry point. Callers assemble an {@link
 * AttributeContext} from trusted sources and pass it in, so decisions are reproducible from their
 * inputs. The four bags follow NIST SP 800-162: subject, resource, action and environment.
 */

/** A flat, provider-supplied attribute bag. Values are `unknown` on purpose: the policy engine is what gives them type meaning. */
export interface AttributeBag {
  readonly [attribute: string]: unknown;
}

/** The subject a decision is being rendered for. */
export interface SubjectRef {
  readonly subjectId: string;
  readonly tenantId: string;
}

/** The resource a decision is being rendered for. */
export interface ResourceRef {
  readonly resourceType: string;
  readonly resourceId?: string;
}

/**
 * Every attribute the evaluation may consult, grouped by the axis it comes from.
 *
 * A missing attribute is deliberately representable: an absent key and a
 * present `undefined` both mean "not resolved", and the condition evaluator
 * treats both as `false` rather than failing open (threat model: attribute
 * provider failure is fail-closed).
 */
export interface AttributeContext {
  /** Attributes of the acting principal — roles held, clearance, organization. */
  readonly subject: AttributeBag;
  /** Attributes of the target — owner, status, sensitivity label. */
  readonly resource: AttributeBag;
  /** Attributes of the operation attempted — `name`, `sensitivity`, `mutates`. */
  readonly action: AttributeBag;
  /** Attributes of the request itself — time, IP, request id. */
  readonly environment: AttributeBag;
}

/** A complete authorization question: who, doing what, to what, with which attributes. */
export interface AuthorizationRequest {
  readonly subject: SubjectRef;
  readonly action: string;
  readonly resource: ResourceRef;
  readonly context?: AttributeContext;
}

/** The attribute context used when a caller supplies none: all four axes empty. */
export function emptyAttributeContext(): AttributeContext {
  return { subject: {}, resource: {}, action: {}, environment: {} };
}
