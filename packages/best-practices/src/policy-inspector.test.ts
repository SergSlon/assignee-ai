import { describe, it, expect } from "vitest";
import {
  inspectPolicyDocument,
  POLICY_ANTIPATTERNS,
  type PolicyAntipattern,
} from "./policy-inspector.js";

// Real-shaped policy documents. These mirror the Wave-20 real-data
// mocks rule — no contrived key names, no stripped Version fields.
// Where an IAM service is named, it matches the docs AWS publishes.

const ALLOW_ALL = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowEverything",
      Effect: "Allow",
      Action: "*",
      Resource: "*",
    },
  ],
};

const NARROW_S3_READ = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadMyBucket",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
    },
  ],
};

const PUBLIC_PRINCIPAL = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "OpenToWorld",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::public-bucket/*",
    },
  ],
};

const AWS_WILDCARD_PRINCIPAL = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: "*" },
      Action: "sns:Subscribe",
      Resource: "arn:aws:sns:us-east-1:123456789012:my-topic",
    },
  ],
};

const SERVICE_PRINCIPAL_OK = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

const ALLOW_PLUS_NOT_ACTION = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowEverythingExceptIam",
      Effect: "Allow",
      NotAction: ["iam:*"],
      Resource: "*",
    },
  ],
};

const ALLOW_PLUS_NOT_RESOURCE = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: "s3:DeleteObject",
      NotResource: ["arn:aws:s3:::critical-bucket/*"],
    },
  ],
};

const TRUST_POLICY_NOT_PRINCIPAL = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      NotPrincipal: {
        AWS: "arn:aws:iam::123456789012:root",
      },
      Action: "sts:AssumeRole",
    },
  ],
};

const PASSROLE_STAR_RESOURCE = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "PassAnyRole",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: "*",
    },
  ],
};

const PASSROLE_SCOPED_OK = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: "arn:aws:iam::123456789012:role/lambda-exec",
    },
  ],
};

const PASSROLE_VIA_IAM_STAR = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: "iam:*",
      Resource: "*",
    },
  ],
};

const DENY_STAR_OK = {
  // Deny statements with wildcards are legitimate (the whole point of
  // a deny is the broad sweep). None of the anti-patterns should
  // match deny statements.
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Principal: "*",
      NotAction: ["s3:GetObject"],
      NotPrincipal: { AWS: "*" },
      NotResource: "*",
    },
  ],
};

const MIXED_WITH_GOOD_AND_BAD = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "GoodRead",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: "arn:aws:s3:::bucket/*",
    },
    {
      Sid: "BadWildcard",
      Effect: "Allow",
      Action: "*",
      Resource: "*",
    },
  ],
};

const SINGLE_STATEMENT_OBJECT = {
  // CloudFormation accepts Statement as a single object, not an array.
  // Our walker must handle both.
  Version: "2012-10-17",
  Statement: {
    Effect: "Allow",
    Action: "*",
    Resource: "*",
  },
};

describe("inspectPolicyDocument", () => {
  describe("wildcard-resource", () => {
    it('matches Resource: "*" on Allow', () => {
      const r = inspectPolicyDocument(ALLOW_ALL, "wildcard-resource");
      expect(r.matched).toBe(true);
      expect(r.offendingStatementIndex).toBe(0);
    });

    it("does not match narrow ARN lists", () => {
      expect(
        inspectPolicyDocument(NARROW_S3_READ, "wildcard-resource"),
      ).toEqual({
        matched: false,
      });
    });

    it("does not match Deny statements with wildcard", () => {
      expect(inspectPolicyDocument(DENY_STAR_OK, "wildcard-resource")).toEqual({
        matched: false,
      });
    });

    it("returns the index of the first offending statement in a mixed document", () => {
      const r = inspectPolicyDocument(
        MIXED_WITH_GOOD_AND_BAD,
        "wildcard-resource",
      );
      expect(r).toEqual({ matched: true, offendingStatementIndex: 1 });
    });

    it("handles Statement: {} (single object form)", () => {
      expect(
        inspectPolicyDocument(SINGLE_STATEMENT_OBJECT, "wildcard-resource"),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });
  });

  describe("wildcard-action", () => {
    it('matches Action: "*"', () => {
      expect(inspectPolicyDocument(ALLOW_ALL, "wildcard-action")).toEqual({
        matched: true,
        offendingStatementIndex: 0,
      });
    });

    it("does not match service-scoped action lists", () => {
      expect(inspectPolicyDocument(NARROW_S3_READ, "wildcard-action")).toEqual({
        matched: false,
      });
    });

    it("does not match Deny with wildcard action", () => {
      expect(inspectPolicyDocument(DENY_STAR_OK, "wildcard-action")).toEqual({
        matched: false,
      });
    });
  });

  describe("wildcard-principal", () => {
    it('matches Principal: "*"', () => {
      expect(
        inspectPolicyDocument(PUBLIC_PRINCIPAL, "wildcard-principal"),
      ).toEqual({
        matched: true,
        offendingStatementIndex: 0,
      });
    });

    it('matches Principal: { AWS: "*" }', () => {
      expect(
        inspectPolicyDocument(AWS_WILDCARD_PRINCIPAL, "wildcard-principal"),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match Principal: { Service: ... }", () => {
      expect(
        inspectPolicyDocument(SERVICE_PRINCIPAL_OK, "wildcard-principal"),
      ).toEqual({ matched: false });
    });

    it("does not match Deny statements with wildcard principal", () => {
      expect(inspectPolicyDocument(DENY_STAR_OK, "wildcard-principal")).toEqual(
        {
          matched: false,
        },
      );
    });
  });

  describe("wildcard-principal-no-condition (Epic 98 W4.B2)", () => {
    // Epic 98 W4.B2 fixtures — real-shaped SNS topic policies. The
    // account id is the reserved-test value per the no-real-ids rule.
    const SNS_WILDCARD_NO_CONDITION = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OpenSubscribe",
          Effect: "Allow",
          Principal: "*",
          Action: "sns:Subscribe",
          Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
        },
      ],
    };

    const SNS_WILDCARD_AWS_NO_CONDITION = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: "sns:Publish",
          Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
        },
      ],
    };

    const SNS_WILDCARD_WITH_SOURCE_ACCOUNT = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CrossAccountPublish",
          Effect: "Allow",
          Principal: "*",
          Action: "sns:Publish",
          Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
          Condition: {
            StringEquals: { "aws:SourceAccount": "210987654321" },
          },
        },
      ],
    };

    const SNS_WILDCARD_WITH_SOURCE_ARN = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: "sns:Publish",
          Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
          Condition: {
            ArnEquals: {
              "aws:SourceArn": "arn:aws:s3:::appdata-210987654321-us-east-1",
            },
          },
        },
      ],
    };

    const SNS_WILDCARD_EMPTY_CONDITION = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: "sns:Subscribe",
          Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
          Condition: {},
        },
      ],
    };

    it("matches wildcard Principal without any Condition clause", () => {
      expect(
        inspectPolicyDocument(
          SNS_WILDCARD_NO_CONDITION,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("matches wildcard { AWS: '*' } without Condition", () => {
      expect(
        inspectPolicyDocument(
          SNS_WILDCARD_AWS_NO_CONDITION,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("matches wildcard Principal with an empty Condition object ({} treated as absent)", () => {
      expect(
        inspectPolicyDocument(
          SNS_WILDCARD_EMPTY_CONDITION,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does NOT match wildcard Principal + aws:SourceAccount Condition (canonical cross-account trust)", () => {
      expect(
        inspectPolicyDocument(
          SNS_WILDCARD_WITH_SOURCE_ACCOUNT,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: false });
    });

    it("does NOT match wildcard Principal + aws:SourceArn Condition (CloudFront/S3 trust shape)", () => {
      expect(
        inspectPolicyDocument(
          SNS_WILDCARD_WITH_SOURCE_ARN,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: false });
    });

    it("does NOT match a Service-principal policy (no wildcard)", () => {
      expect(
        inspectPolicyDocument(
          SERVICE_PRINCIPAL_OK,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: false });
    });

    it("does NOT match a narrow-ARN Allow (no wildcard)", () => {
      expect(
        inspectPolicyDocument(
          NARROW_S3_READ,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: false });
    });

    it("does NOT match Deny + wildcard Principal (legitimate deny sweep)", () => {
      expect(
        inspectPolicyDocument(DENY_STAR_OK, "wildcard-principal-no-condition"),
      ).toEqual({ matched: false });
    });

    it("matches when one of multiple statements carries a bare wildcard (mixed doc)", () => {
      const MIXED_CONDITIONED_AND_BARE = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ConditionedOK",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Publish",
            Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
            Condition: {
              StringEquals: { "aws:SourceAccount": "210987654321" },
            },
          },
          {
            Sid: "BareWildcardLeaky",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
          },
        ],
      };
      expect(
        inspectPolicyDocument(
          MIXED_CONDITIONED_AND_BARE,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 1 });
    });

    it("matches when Condition is null (treated-as-absent semantics)", () => {
      // Author-error: explicit Condition: null. Treated as "no
      // condition" and the rule SHOULD fire — guards against YAML
      // authors using null instead of {} to signal "empty".
      const NULL_CONDITION = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
            Condition: null,
          },
        ],
      };
      expect(
        inspectPolicyDocument(
          NULL_CONDITION,
          "wildcard-principal-no-condition",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });
  });

  describe("allow-plus-not-action", () => {
    it("matches Allow + NotAction presence", () => {
      expect(
        inspectPolicyDocument(ALLOW_PLUS_NOT_ACTION, "allow-plus-not-action"),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match narrow Allow without NotAction", () => {
      expect(
        inspectPolicyDocument(NARROW_S3_READ, "allow-plus-not-action"),
      ).toEqual({
        matched: false,
      });
    });

    it("does not match Deny + NotAction (legitimate deny pattern)", () => {
      expect(
        inspectPolicyDocument(DENY_STAR_OK, "allow-plus-not-action"),
      ).toEqual({
        matched: false,
      });
    });
  });

  describe("allow-plus-not-resource", () => {
    it("matches Allow + NotResource presence", () => {
      expect(
        inspectPolicyDocument(
          ALLOW_PLUS_NOT_RESOURCE,
          "allow-plus-not-resource",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match Deny + NotResource", () => {
      expect(
        inspectPolicyDocument(DENY_STAR_OK, "allow-plus-not-resource"),
      ).toEqual({
        matched: false,
      });
    });
  });

  describe("allow-plus-not-principal", () => {
    it("matches Allow + NotPrincipal in a trust policy", () => {
      expect(
        inspectPolicyDocument(
          TRUST_POLICY_NOT_PRINCIPAL,
          "allow-plus-not-principal",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match a normal trust policy with service principal", () => {
      expect(
        inspectPolicyDocument(SERVICE_PRINCIPAL_OK, "allow-plus-not-principal"),
      ).toEqual({ matched: false });
    });

    it("does not match Deny + NotPrincipal", () => {
      expect(
        inspectPolicyDocument(DENY_STAR_OK, "allow-plus-not-principal"),
      ).toEqual({ matched: false });
    });
  });

  describe("passrole-wildcard-resource", () => {
    it("matches iam:PassRole with Resource: *", () => {
      expect(
        inspectPolicyDocument(
          PASSROLE_STAR_RESOURCE,
          "passrole-wildcard-resource",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match iam:PassRole scoped to a specific role ARN", () => {
      expect(
        inspectPolicyDocument(PASSROLE_SCOPED_OK, "passrole-wildcard-resource"),
      ).toEqual({ matched: false });
    });

    it("matches iam:* with Resource: * (covers PassRole)", () => {
      expect(
        inspectPolicyDocument(
          PASSROLE_VIA_IAM_STAR,
          "passrole-wildcard-resource",
        ),
      ).toEqual({ matched: true, offendingStatementIndex: 0 });
    });

    it("does not match non-iam actions with Resource: *", () => {
      const doc = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "logs:PutLogEvents",
            Resource: "*",
          },
        ],
      };
      expect(inspectPolicyDocument(doc, "passrole-wildcard-resource")).toEqual({
        matched: false,
      });
    });
  });

  describe("malformed / edge-case inputs", () => {
    it("returns matched: false for null", () => {
      expect(inspectPolicyDocument(null, "wildcard-resource")).toEqual({
        matched: false,
      });
    });

    it("returns matched: false for undefined", () => {
      expect(inspectPolicyDocument(undefined, "wildcard-resource")).toEqual({
        matched: false,
      });
    });

    it("returns matched: false for a primitive string", () => {
      expect(
        inspectPolicyDocument("not a policy", "wildcard-resource"),
      ).toEqual({
        matched: false,
      });
    });

    it("returns matched: false when Statement is absent", () => {
      expect(
        inspectPolicyDocument({ Version: "2012-10-17" }, "wildcard-resource"),
      ).toEqual({ matched: false });
    });

    it("returns matched: false when Statement is an empty array", () => {
      expect(
        inspectPolicyDocument(
          { Version: "2012-10-17", Statement: [] },
          "wildcard-resource",
        ),
      ).toEqual({ matched: false });
    });

    it("treats missing Effect as Allow (IAM default)", () => {
      // IAM spec: when Effect is omitted, statements default to Allow.
      // Our walker must flag wildcards in these statements, not skip them.
      const doc = {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "*",
            Resource: "*",
          },
        ],
      };
      expect(inspectPolicyDocument(doc, "wildcard-resource")).toEqual({
        matched: true,
        offendingStatementIndex: 0,
      });
    });

    it("skips non-object statement entries without crashing", () => {
      const doc = {
        Version: "2012-10-17",
        // A malformed document with a string inside Statement[].
        Statement: ["not-a-statement-object"],
      };
      expect(inspectPolicyDocument(doc, "wildcard-resource")).toEqual({
        matched: false,
      });
    });

    it("returns matched: false for an unknown antipattern name", () => {
      expect(
        inspectPolicyDocument(
          ALLOW_ALL,
          "not-a-real-pattern" as PolicyAntipattern,
        ),
      ).toEqual({ matched: false });
    });
  });

  describe("POLICY_ANTIPATTERNS catalogue", () => {
    it("contains exactly the nine patterns we enforce (Epic 98 W4.B4 added missing-secure-transport-deny)", () => {
      // If this count changes, update the gap-analysis memo in
      // docs/bp-cfn-guard-gap-analysis-2026-04-08.md too.
      expect(POLICY_ANTIPATTERNS).toHaveLength(9);
      expect([...POLICY_ANTIPATTERNS].sort()).toEqual(
        [
          "allow-plus-not-action",
          "allow-plus-not-principal",
          "allow-plus-not-resource",
          "missing-secure-transport-deny",
          "passrole-wildcard-resource",
          "wildcard-action",
          "wildcard-principal",
          "wildcard-principal-no-condition",
          "wildcard-resource",
        ].sort(),
      );
    });

    it("has a check for every catalogued pattern (no orphans)", () => {
      for (const pattern of POLICY_ANTIPATTERNS) {
        // None of the patterns should throw on a minimal valid doc.
        expect(() =>
          inspectPolicyDocument(NARROW_S3_READ, pattern),
        ).not.toThrow();
      }
    });
  });
});
