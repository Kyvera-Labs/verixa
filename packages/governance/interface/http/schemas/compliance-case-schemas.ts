import { WORKFLOW_TYPES } from "../../../domain/workflow-definitions.js";

/**
 * JSON Schemas for the compliance-case routes. They validate request *shape*
 * only (types, lengths, enums; unknown keys are stripped by Fastify's validator). Which transitions are legal
 * is the domain's decision and is deliberately not encoded here.
 *
 * Note what the transition body does not contain: a target state. Clients name
 * an event and the server's transition table decides the destination.
 */
const id = { type: "string", minLength: 1, maxLength: 128 } as const;

export const orgParamsSchema = {
  $id: "ComplianceCaseOrgParams",
  type: "object",
  required: ["orgId"],
  additionalProperties: false,
  properties: { orgId: id },
} as const;

export const caseParamsSchema = {
  $id: "ComplianceCaseParams",
  type: "object",
  required: ["orgId", "caseId"],
  additionalProperties: false,
  properties: { orgId: id, caseId: id },
} as const;

export const createCaseBodySchema = {
  $id: "ComplianceCaseCreateBody",
  type: "object",
  required: ["workflowType", "title"],
  additionalProperties: false,
  properties: {
    workflowType: { type: "string", enum: [...WORKFLOW_TYPES] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    assigneeId: { anyOf: [id, { type: "null" }] },
  },
} as const;

export const listCasesQuerySchema = {
  $id: "ComplianceCaseListQuery",
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", minLength: 1, maxLength: 64 },
    type: { type: "string", enum: [...WORKFLOW_TYPES] },
    assignee: id,
  },
} as const;

export const transitionBodySchema = {
  $id: "ComplianceCaseTransitionBody",
  type: "object",
  required: ["event"],
  additionalProperties: false,
  properties: {
    event: { type: "string", minLength: 1, maxLength: 64 },
    assigneeId: { anyOf: [id, { type: "null" }] },
  },
} as const;

export const approvalBodySchema = {
  $id: "ComplianceCaseApprovalBody",
  type: "object",
  required: ["role", "decision"],
  additionalProperties: false,
  properties: {
    role: { type: "string", minLength: 1, maxLength: 64 },
    decision: { type: "string", enum: ["approved", "rejected"] },
    comment: { type: "string", maxLength: 1000 },
  },
} as const;

export const COMPLIANCE_CASE_SCHEMAS = [
  orgParamsSchema,
  caseParamsSchema,
  createCaseBodySchema,
  listCasesQuerySchema,
  transitionBodySchema,
  approvalBodySchema,
] as const;
