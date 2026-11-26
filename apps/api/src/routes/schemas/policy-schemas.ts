import { z } from "zod";

export const policyOrganizationParamsZod = z.object({ orgId: z.string().min(1) }).strict();
export const policyParamsZod = z
  .object({ orgId: z.string().min(1), policyId: z.string().min(1) })
  .strict();
export const createPolicyBodyZod = z
  .object({ name: z.string().trim().min(1), ruleset: z.record(z.unknown()) })
  .strict();
export const updatePolicyBodyZod = z
  .object({ name: z.string().trim().min(1).optional(), ruleset: z.record(z.unknown()).optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.ruleset !== undefined, {
    message: "At least one policy field must be provided.",
  });
export const policyVersionsQueryZod = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type PolicyOrganizationParams = z.infer<typeof policyOrganizationParamsZod>;
export type PolicyParams = z.infer<typeof policyParamsZod>;
export type CreatePolicyBody = z.infer<typeof createPolicyBodyZod>;
export type UpdatePolicyBody = z.infer<typeof updatePolicyBodyZod>;
export type PolicyVersionsQuery = z.infer<typeof policyVersionsQueryZod>;
