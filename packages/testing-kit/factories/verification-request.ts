import { asId, createId } from "@verixa/shared-kernel";
import {
  VerificationRequest,
  type VerificationRequestId,
  VerificationType,
  type VerificationTypeValue,
  type VerificationOrganizationId,
  type VerificationSubjectId,
} from "@verixa/verification";

import { unwrapResult } from "./result-helper.js";

export interface VerificationRequestFactoryOptions {
  id?: VerificationRequestId | string;
  subjectUserId?: VerificationSubjectId | string;
  organizationId?: VerificationOrganizationId | string;
  type?: VerificationType | VerificationTypeValue;
}

/**
 * Creates a domain-valid `VerificationRequest` aggregate with sensible defaults and optional overrides.
 */
export function makeVerificationRequest(
  overrides: VerificationRequestFactoryOptions = {},
): VerificationRequest {
  const subjectUserId = (overrides.subjectUserId
    ? typeof overrides.subjectUserId === "string"
      ? asId<"UserId">(overrides.subjectUserId)
      : overrides.subjectUserId
    : createId<"UserId">()) as unknown as VerificationSubjectId;

  const organizationId = (overrides.organizationId
    ? typeof overrides.organizationId === "string"
      ? asId<"OrganizationId">(overrides.organizationId)
      : overrides.organizationId
    : createId<"OrganizationId">()) as unknown as VerificationOrganizationId;

  const verificationType =
    overrides.type instanceof VerificationType
      ? overrides.type
      : typeof overrides.type === "string"
        ? unwrapResult(VerificationType.create(overrides.type))
        : unwrapResult(VerificationType.create("identity-document"));

  return VerificationRequest.request({
    subjectUserId,
    organizationId,
    type: verificationType,
  });
}
