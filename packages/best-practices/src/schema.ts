import { z } from "zod";
import { BP_SEVERITY, BP_CATEGORY, BP_CHECK_TYPE } from "./types.js";

const triggerSchema = z
  .object({
    resourceType: z.string().optional(),
    fieldCondition: z.string().optional(),
    patternId: z.string().optional(),
    intentKeywords: z.array(z.string()).optional(),
    always: z.boolean().optional(),
  })
  .strict();

export const bestPracticeSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^BP-[A-Z0-9]+-\d{3}$/,
        "BP ID must match format BP-{SERVICE}-{NNN}",
      ),
    title: z.string().min(1),
    severity: z.enum(BP_SEVERITY),
    resource_type: z.string().min(1),
    property_path: z.string().min(1),
    check_type: z.enum(BP_CHECK_TYPE),
    expected_value: z.unknown(),
    source: z.string().min(1),
    source_id: z.string().optional(),
    description: z.string().optional(),
    remediation: z.string().optional(),
    category: z.enum(BP_CATEGORY),
    version: z.string().optional(),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    triggers: z.array(triggerSchema).optional(),
    autoFixable: z.boolean().optional(),
    desiredStatePatch: z.record(z.unknown()).optional(),
    blocking: z.boolean().optional().default(false),
  })
  .strict();
