import { describe, it, expect } from "vitest";
import { iamRolePlugin } from "./iam-role.js";

describe("iamRolePlugin", () => {
  it("has the correct resourceType", () => {
    expect(iamRolePlugin.resourceType).toBe("AWS::IAM::Role");
  });

  it("commonFields count is ≤10", () => {
    expect(iamRolePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(iamRolePlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of iamRolePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("RoleName validation", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "RoleName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid role name", () => {
      expect(field.question.validate?.("my-app-role")).toBeUndefined();
    });

    // Wave 16: strengthened — validators MUST return a non-empty
    // STRING error message rather than just any non-undefined value.
    it("rejects names longer than 64 chars", () => {
      const err = field.question.validate?.("a".repeat(65));
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects names with invalid characters", () => {
      const err = field.question.validate?.("my role!");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });
  });

  it("AssumeRolePolicyDocument is required enum with 3 options", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "AssumeRolePolicyDocument",
    );
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("enum");
    expect(field?.question.options).toHaveLength(3);
  });

  describe("AssumeRolePolicyDocument toCfn transform", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "AssumeRolePolicyDocument",
    )!;

    it("transforms 'lambda' to Lambda trust policy", () => {
      const result = field.toCfn!("lambda") as Record<string, unknown>;
      expect(result).toHaveProperty("Version", "2012-10-17");
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "lambda.amazonaws.com",
      });
    });

    it("transforms 'ec2' to EC2 trust policy", () => {
      const result = field.toCfn!("ec2") as Record<string, unknown>;
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "ec2.amazonaws.com",
      });
    });

    it("transforms 'ecs' to ECS trust policy", () => {
      const result = field.toCfn!("ecs") as Record<string, unknown>;
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "ecs-tasks.amazonaws.com",
      });
    });

    // Wave 19 Bug #2: the LLM plan_generator emits a real AssumeRolePolicyDocument
    // (either as a parsed object or as a JSON string — the live 2026-04-08
    // smoke showed the JSON-string variant). Before this fix, the toCfn path
    // fell through to the enum lookup, emitted a scary "Unknown trust policy"
    // warning (with the literal JSON inside the message), and the
    // required-field validator killed every plain-intent
    // `assignee apply "Create an IAM role ..."` run. These tests lock in the
    // pass-through behavior for both LLM shapes and verify malformed input
    // still warns + drops.
    describe("Wave 19 Bug #2: pass-through LLM-generated policy document", () => {
      it("passes through a real AssumeRolePolicyDocument object unchanged", () => {
        const llmPolicy = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        };
        const result = field.toCfn!(llmPolicy);
        // Identity preservation — the LLM policy must reach CCAPI unchanged
        expect(result).toBe(llmPolicy);
      });

      it("parses a JSON-string AssumeRolePolicyDocument (real 2026-04-08 reproducer)", () => {
        // Exact shape observed in the 2026-04-08 live smoke logs:
        //   Warning: Unknown trust policy "{"Version":"2012-10-17",...}"
        // The LLM emitted this as a JSON string and the enum lookup failed.
        const llmJsonString = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        });
        const result = field.toCfn!(llmJsonString) as Record<string, unknown>;
        // Tier C: dropped redundant toBeDefined() — the subsequent
        // property access (`result["Version"]`) would throw on undefined
        // anyway, AND the toBe() assertion is strictly stronger.
        expect(result["Version"]).toBe("2012-10-17");
        const statements = result["Statement"] as Array<
          Record<string, unknown>
        >;
        expect(statements[0]?.["Principal"]).toEqual({
          Service: "ec2.amazonaws.com",
        });
      });

      it("does NOT crash on a JSON string with whitespace and indentation", () => {
        const llmJsonString = `  {
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Principal": { "Service": "lambda.amazonaws.com" },
              "Action": "sts:AssumeRole"
            }
          ]
        }  `;
        const result = field.toCfn!(llmJsonString) as Record<string, unknown>;
        // Tier C: dropped redundant toBeDefined() — Principal assertion
        // fails fast on undefined result.
        const statements = result["Statement"] as Array<
          Record<string, unknown>
        >;
        expect(statements[0]?.["Principal"]).toEqual({
          Service: "lambda.amazonaws.com",
        });
      });

      it("falls back to enum lookup when JSON.parse fails on a non-policy string", () => {
        // String that starts with `{` but isn't valid JSON — should NOT
        // match the JSON-string path, must fall through to enum lookup,
        // and since "{not json}" isn't a valid enum key, should warn+drop.
        const result = field.toCfn!("{not json}");
        expect(result).toBeUndefined();
      });

      it("passes through a multi-statement policy unchanged", () => {
        const llmPolicy = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
              Condition: {
                StringEquals: { "aws:PrincipalAccount": "123456789012" },
              },
            },
          ],
        };
        const result = field.toCfn!(llmPolicy);
        expect(result).toBe(llmPolicy);
      });

      it("falls back to enum lookup for string input", () => {
        // Wizard path must still work — string input matches TRUST_POLICIES
        const result = field.toCfn!("lambda") as Record<string, unknown>;
        const statements = result["Statement"] as Array<
          Record<string, unknown>
        >;
        expect(statements[0]?.["Principal"]).toEqual({
          Service: "lambda.amazonaws.com",
        });
      });

      it("returns undefined for malformed object (no Statement array)", () => {
        // Not a valid policy shape — fall through to enum, which won't
        // match "[object Object]", so warn-and-drop is the correct behavior
        const result = field.toCfn!({ Version: "2012-10-17" });
        expect(result).toBeUndefined();
      });

      it("returns undefined for object with empty Statement array", () => {
        const result = field.toCfn!({
          Version: "2012-10-17",
          Statement: [],
        });
        expect(result).toBeUndefined();
      });

      it("returns undefined for null input", () => {
        expect(field.toCfn!(null)).toBeUndefined();
      });

      it("returns undefined for array input (not a policy object)", () => {
        expect(field.toCfn!([{ Statement: [] }])).toBeUndefined();
      });
    });
  });

  describe("MaxSessionDuration toCfn", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "MaxSessionDuration",
    )!;

    it("converts string to number", () => {
      expect(field.toCfn!("7200")).toBe(7200);
    });
  });

  it("Tags field has toCfn transform", () => {
    const field = iamRolePlugin.commonFields.find((f) => f.name === "Tags");
    // Wave 16: strengthened — assert by name + that toCfn is callable.
    expect(field?.name).toBe("Tags");
    expect(typeof field?.toCfn).toBe("function");
  });

  it("advancedFields contains ManagedPolicyArns", () => {
    const names = iamRolePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("ManagedPolicyArns");
  });

  it("commonFields contains PermissionsBoundary", () => {
    const names = iamRolePlugin.commonFields.map((f) => f.name);
    expect(names).toContain("PermissionsBoundary");
  });

  describe("ManagedPolicyArns toCfn transform", () => {
    const field = iamRolePlugin.advancedFields.find(
      (f) => f.name === "ManagedPolicyArns",
    )!;

    it("splits comma-separated ARNs into array", () => {
      const input =
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess, arn:aws:iam::aws:policy/CloudWatchLogsFullAccess";
      const result = field.toCfn!(input);
      expect(result).toEqual([
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess",
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("has configHints about AdminAccess and least privilege", () => {
    // Wave 16: dropped redundant `toBeDefined()` — `Array.isArray`
    // catches null/undefined AND non-array shapes.
    expect(Array.isArray(iamRolePlugin.configHints)).toBe(true);
    expect(iamRolePlugin.configHints!.length).toBeGreaterThan(0);
    const hints = iamRolePlugin.configHints!.join(" ");
    expect(hints).toContain("AdministratorAccess");
  });

  it("defaults include MaxSessionDuration", () => {
    expect(iamRolePlugin.defaults).toEqual({ MaxSessionDuration: 3600 });
  });
});
