import { z } from "zod";
export declare const bestPracticeSchema: z.ZodEffects<
  z.ZodEffects<
    z.ZodObject<
      {
        id: z.ZodString;
        title: z.ZodString;
        severity: z.ZodEnum<["CRITICAL", "HIGH", "MEDIUM", "INFO"]>;
        resource_type: z.ZodString;
        property_path: z.ZodString;
        check_type: z.ZodEnum<
          [
            "equals",
            "not_equals",
            "exists",
            "not_exists",
            "greater_than",
            "less_than",
            "contains",
            "not_contains",
            "conditional_forbidden",
            "cross_resource_count",
            "cross_resource_reference",
            "awareness",
          ]
        >;
        expected_value: z.ZodUnknown;
        source: z.ZodString;
        source_id: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        remediation: z.ZodOptional<z.ZodString>;
        category: z.ZodEnum<
          [
            "security",
            "cost",
            "cost_optimization",
            "reliability",
            "performance",
            "compliance",
          ]
        >;
        version: z.ZodOptional<z.ZodString>;
        lastVerified: z.ZodString;
        triggers: z.ZodOptional<
          z.ZodArray<
            z.ZodObject<
              {
                resourceType: z.ZodOptional<z.ZodString>;
                fieldCondition: z.ZodOptional<z.ZodString>;
                patternId: z.ZodOptional<z.ZodString>;
                intentKeywords: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                always: z.ZodOptional<z.ZodBoolean>;
                excludePatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
              },
              "strict",
              z.ZodTypeAny,
              {
                resourceType?: string | undefined;
                patternId?: string | undefined;
                fieldCondition?: string | undefined;
                intentKeywords?: string[] | undefined;
                always?: boolean | undefined;
                excludePatterns?: string[] | undefined;
              },
              {
                resourceType?: string | undefined;
                patternId?: string | undefined;
                fieldCondition?: string | undefined;
                intentKeywords?: string[] | undefined;
                always?: boolean | undefined;
                excludePatterns?: string[] | undefined;
              }
            >,
            "many"
          >
        >;
        autoFixable: z.ZodOptional<z.ZodBoolean>;
        desiredStatePatch: z.ZodOptional<
          z.ZodRecord<z.ZodString, z.ZodUnknown>
        >;
        blocking: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        condition: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        fix_hint: z.ZodOptional<z.ZodString>;
        fixType: z.ZodOptional<z.ZodEnum<["auto", "interactive", "info"]>>;
        interactiveOptions: z.ZodOptional<
          z.ZodArray<
            z.ZodObject<
              {
                label: z.ZodString;
                action: z.ZodEnum<
                  ["prompt_value", "set_value", "remove_property", "skip"]
                >;
                targetField: z.ZodOptional<z.ZodString>;
                targetValue: z.ZodOptional<z.ZodUnknown>;
              },
              "strip",
              z.ZodTypeAny,
              {
                label: string;
                action:
                  | "skip"
                  | "prompt_value"
                  | "set_value"
                  | "remove_property";
                targetField?: string | undefined;
                targetValue?: unknown;
              },
              {
                label: string;
                action:
                  | "skip"
                  | "prompt_value"
                  | "set_value"
                  | "remove_property";
                targetField?: string | undefined;
                targetValue?: unknown;
              }
            >,
            "many"
          >
        >;
      },
      "strict",
      z.ZodTypeAny,
      {
        id: string;
        title: string;
        severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
        resource_type: string;
        property_path: string;
        check_type:
          | "contains"
          | "equals"
          | "not_equals"
          | "exists"
          | "not_exists"
          | "greater_than"
          | "less_than"
          | "not_contains"
          | "conditional_forbidden"
          | "cross_resource_count"
          | "cross_resource_reference"
          | "awareness";
        source: string;
        category:
          | "security"
          | "cost"
          | "cost_optimization"
          | "reliability"
          | "performance"
          | "compliance";
        lastVerified: string;
        blocking: boolean;
        description?: string | undefined;
        expected_value?: unknown;
        source_id?: string | undefined;
        remediation?: string | undefined;
        version?: string | undefined;
        triggers?:
          | {
              resourceType?: string | undefined;
              patternId?: string | undefined;
              fieldCondition?: string | undefined;
              intentKeywords?: string[] | undefined;
              always?: boolean | undefined;
              excludePatterns?: string[] | undefined;
            }[]
          | undefined;
        autoFixable?: boolean | undefined;
        desiredStatePatch?: Record<string, unknown> | undefined;
        condition?: Record<string, unknown> | undefined;
        fix_hint?: string | undefined;
        fixType?: "auto" | "interactive" | "info" | undefined;
        interactiveOptions?:
          | {
              label: string;
              action: "skip" | "prompt_value" | "set_value" | "remove_property";
              targetField?: string | undefined;
              targetValue?: unknown;
            }[]
          | undefined;
      },
      {
        id: string;
        title: string;
        severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
        resource_type: string;
        property_path: string;
        check_type:
          | "contains"
          | "equals"
          | "not_equals"
          | "exists"
          | "not_exists"
          | "greater_than"
          | "less_than"
          | "not_contains"
          | "conditional_forbidden"
          | "cross_resource_count"
          | "cross_resource_reference"
          | "awareness";
        source: string;
        category:
          | "security"
          | "cost"
          | "cost_optimization"
          | "reliability"
          | "performance"
          | "compliance";
        lastVerified: string;
        description?: string | undefined;
        expected_value?: unknown;
        source_id?: string | undefined;
        remediation?: string | undefined;
        version?: string | undefined;
        triggers?:
          | {
              resourceType?: string | undefined;
              patternId?: string | undefined;
              fieldCondition?: string | undefined;
              intentKeywords?: string[] | undefined;
              always?: boolean | undefined;
              excludePatterns?: string[] | undefined;
            }[]
          | undefined;
        autoFixable?: boolean | undefined;
        desiredStatePatch?: Record<string, unknown> | undefined;
        blocking?: boolean | undefined;
        condition?: Record<string, unknown> | undefined;
        fix_hint?: string | undefined;
        fixType?: "auto" | "interactive" | "info" | undefined;
        interactiveOptions?:
          | {
              label: string;
              action: "skip" | "prompt_value" | "set_value" | "remove_property";
              targetField?: string | undefined;
              targetValue?: unknown;
            }[]
          | undefined;
      }
    >,
    {
      id: string;
      title: string;
      severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
      resource_type: string;
      property_path: string;
      check_type:
        | "contains"
        | "equals"
        | "not_equals"
        | "exists"
        | "not_exists"
        | "greater_than"
        | "less_than"
        | "not_contains"
        | "conditional_forbidden"
        | "cross_resource_count"
        | "cross_resource_reference"
        | "awareness";
      source: string;
      category:
        | "security"
        | "cost"
        | "cost_optimization"
        | "reliability"
        | "performance"
        | "compliance";
      lastVerified: string;
      blocking: boolean;
      description?: string | undefined;
      expected_value?: unknown;
      source_id?: string | undefined;
      remediation?: string | undefined;
      version?: string | undefined;
      triggers?:
        | {
            resourceType?: string | undefined;
            patternId?: string | undefined;
            fieldCondition?: string | undefined;
            intentKeywords?: string[] | undefined;
            always?: boolean | undefined;
            excludePatterns?: string[] | undefined;
          }[]
        | undefined;
      autoFixable?: boolean | undefined;
      desiredStatePatch?: Record<string, unknown> | undefined;
      condition?: Record<string, unknown> | undefined;
      fix_hint?: string | undefined;
      fixType?: "auto" | "interactive" | "info" | undefined;
      interactiveOptions?:
        | {
            label: string;
            action: "skip" | "prompt_value" | "set_value" | "remove_property";
            targetField?: string | undefined;
            targetValue?: unknown;
          }[]
        | undefined;
    },
    {
      id: string;
      title: string;
      severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
      resource_type: string;
      property_path: string;
      check_type:
        | "contains"
        | "equals"
        | "not_equals"
        | "exists"
        | "not_exists"
        | "greater_than"
        | "less_than"
        | "not_contains"
        | "conditional_forbidden"
        | "cross_resource_count"
        | "cross_resource_reference"
        | "awareness";
      source: string;
      category:
        | "security"
        | "cost"
        | "cost_optimization"
        | "reliability"
        | "performance"
        | "compliance";
      lastVerified: string;
      description?: string | undefined;
      expected_value?: unknown;
      source_id?: string | undefined;
      remediation?: string | undefined;
      version?: string | undefined;
      triggers?:
        | {
            resourceType?: string | undefined;
            patternId?: string | undefined;
            fieldCondition?: string | undefined;
            intentKeywords?: string[] | undefined;
            always?: boolean | undefined;
            excludePatterns?: string[] | undefined;
          }[]
        | undefined;
      autoFixable?: boolean | undefined;
      desiredStatePatch?: Record<string, unknown> | undefined;
      blocking?: boolean | undefined;
      condition?: Record<string, unknown> | undefined;
      fix_hint?: string | undefined;
      fixType?: "auto" | "interactive" | "info" | undefined;
      interactiveOptions?:
        | {
            label: string;
            action: "skip" | "prompt_value" | "set_value" | "remove_property";
            targetField?: string | undefined;
            targetValue?: unknown;
          }[]
        | undefined;
    }
  >,
  {
    id: string;
    title: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
    resource_type: string;
    property_path: string;
    check_type:
      | "contains"
      | "equals"
      | "not_equals"
      | "exists"
      | "not_exists"
      | "greater_than"
      | "less_than"
      | "not_contains"
      | "conditional_forbidden"
      | "cross_resource_count"
      | "cross_resource_reference"
      | "awareness";
    source: string;
    category:
      | "security"
      | "cost"
      | "cost_optimization"
      | "reliability"
      | "performance"
      | "compliance";
    lastVerified: string;
    blocking: boolean;
    description?: string | undefined;
    expected_value?: unknown;
    source_id?: string | undefined;
    remediation?: string | undefined;
    version?: string | undefined;
    triggers?:
      | {
          resourceType?: string | undefined;
          patternId?: string | undefined;
          fieldCondition?: string | undefined;
          intentKeywords?: string[] | undefined;
          always?: boolean | undefined;
          excludePatterns?: string[] | undefined;
        }[]
      | undefined;
    autoFixable?: boolean | undefined;
    desiredStatePatch?: Record<string, unknown> | undefined;
    condition?: Record<string, unknown> | undefined;
    fix_hint?: string | undefined;
    fixType?: "auto" | "interactive" | "info" | undefined;
    interactiveOptions?:
      | {
          label: string;
          action: "skip" | "prompt_value" | "set_value" | "remove_property";
          targetField?: string | undefined;
          targetValue?: unknown;
        }[]
      | undefined;
  },
  {
    id: string;
    title: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
    resource_type: string;
    property_path: string;
    check_type:
      | "contains"
      | "equals"
      | "not_equals"
      | "exists"
      | "not_exists"
      | "greater_than"
      | "less_than"
      | "not_contains"
      | "conditional_forbidden"
      | "cross_resource_count"
      | "cross_resource_reference"
      | "awareness";
    source: string;
    category:
      | "security"
      | "cost"
      | "cost_optimization"
      | "reliability"
      | "performance"
      | "compliance";
    lastVerified: string;
    description?: string | undefined;
    expected_value?: unknown;
    source_id?: string | undefined;
    remediation?: string | undefined;
    version?: string | undefined;
    triggers?:
      | {
          resourceType?: string | undefined;
          patternId?: string | undefined;
          fieldCondition?: string | undefined;
          intentKeywords?: string[] | undefined;
          always?: boolean | undefined;
          excludePatterns?: string[] | undefined;
        }[]
      | undefined;
    autoFixable?: boolean | undefined;
    desiredStatePatch?: Record<string, unknown> | undefined;
    blocking?: boolean | undefined;
    condition?: Record<string, unknown> | undefined;
    fix_hint?: string | undefined;
    fixType?: "auto" | "interactive" | "info" | undefined;
    interactiveOptions?:
      | {
          label: string;
          action: "skip" | "prompt_value" | "set_value" | "remove_property";
          targetField?: string | undefined;
          targetValue?: unknown;
        }[]
      | undefined;
  }
>;
//# sourceMappingURL=schema.d.ts.map
