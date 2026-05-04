/**
 * Regression tests for Bedrock log read-restriction policy.
 *
 * Bug history: the Deny statement used bare `Principal: "*"`, which
 * CloudWatch Logs PutResourcePolicy rejects for these IAM-principal
 * actions ("Principal '*' is not permitted for the Actions specified
 * in the resource policy"). The accepted form is `Principal: {AWS: "*"}`.
 */
import { describe, it, expect } from "vitest";
import { buildBedrockLogReadRestriction } from "./read-restriction-policy.js";

describe("buildBedrockLogReadRestriction", () => {
  const opts = {
    partition: "aws",
    accountId: "111122223333",
    region: "us-east-1",
  };

  it('uses `Principal: {AWS: "*"}` (the form CW Logs accepts), not bare `"*"`', () => {
    const doc = JSON.parse(buildBedrockLogReadRestriction(opts));
    const stmt = doc.Statement[0];
    // Object form, not string form — CW Logs PutResourcePolicy rejects
    // the bare-string variant for these read actions.
    expect(typeof stmt.Principal).toBe("object");
    expect(stmt.Principal).toEqual({ AWS: "*" });
  });

  it("denies the three read actions only", () => {
    const doc = JSON.parse(buildBedrockLogReadRestriction(opts));
    const stmt = doc.Statement[0];
    expect(stmt.Effect).toBe("Deny");
    expect(stmt.Action.sort()).toEqual(
      ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartQuery"].sort(),
    );
  });

  it("escape hatch: operator + root principals are allowed via aws:PrincipalArn", () => {
    const doc = JSON.parse(buildBedrockLogReadRestriction(opts));
    const stmt = doc.Statement[0];
    const allowed = stmt.Condition.StringNotEquals["aws:PrincipalArn"];
    expect(allowed).toContain(
      "arn:aws:iam::111122223333:user/assignee-operator",
    );
    expect(allowed).toContain("arn:aws:iam::111122223333:root");
  });
});
