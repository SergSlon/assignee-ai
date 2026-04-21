/**
 * Tests for `arn-type-map.ts` — the single source of truth for
 * converting an ARN's (service, resource) pair into a CloudFormation
 * `AWS::<Service>::<Resource>` string.
 *
 * Focus: the Events subtype split introduced by Story
 * e92.1.b-followup. Prior to that split, every Events ARN classified
 * as `AWS::Events::Rule` because `SERVICE_TYPE_MAP["events"]` forced
 * the answer before any subtype dispatch ran. This misclassified
 * EventBus / Connection / ApiDestination in `assignee list`,
 * provision-record classification, and every other consumer of
 * `arnToCloudFormationType`.
 *
 * Uses real ARN shapes from live AWS, with account IDs redacted to
 * `<ACCOUNT_ID>`. Partition-aware per
 * feedback_partition_aware_arn_matching — covers commercial `aws`,
 * GovCloud `aws-us-gov`, and China `aws-cn` prefixes.
 */
import { describe, it, expect } from "vitest";
import {
  arnToCloudFormationType,
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
} from "./arn-type-map.js";

const ACCOUNT_ID = "<ACCOUNT_ID>";

/**
 * Splits an ARN into (service, resourcePart) the same way
 * `parseArn` does (colon split, take slots 2 and 5). Tests use this
 * helper to exercise `arnToCloudFormationType` against fully-formed
 * ARNs — the shape it sees in production from RGTA.
 */
function classify(arn: string): string {
  const parts = arn.split(":");
  // Slot 5 onwards may contain additional colons (e.g. Lambda's
  // `function:name`, or SNS topic ARN). Rejoin them so the subtype
  // dispatcher sees the real resource segment shape.
  const resourcePart = parts.slice(5).join(":");
  return arnToCloudFormationType(parts[2] ?? "", resourcePart);
}

describe("arn-type-map — Events subtype split (Story e92.1.b-followup)", () => {
  describe("commercial partition (aws)", () => {
    it("classifies an Events Rule ARN as AWS::Events::Rule", () => {
      expect(
        classify(
          `arn:aws:events:us-east-1:${ACCOUNT_ID}:rule/assignee-cron-nightly`,
        ),
      ).toBe("AWS::Events::Rule");
    });

    it("classifies an Events Rule on a custom bus (7-part ARN) as AWS::Events::Rule", () => {
      // Real AWS shape when a rule lives on a non-default bus:
      //   arn:aws:events:<region>:<account>:rule/<bus-name>/<rule-name>
      expect(
        classify(
          `arn:aws:events:us-east-1:${ACCOUNT_ID}:rule/assignee-bus/assignee-cron`,
        ),
      ).toBe("AWS::Events::Rule");
    });

    it("classifies an Events EventBus ARN as AWS::Events::EventBus", () => {
      expect(
        classify(
          `arn:aws:events:us-east-1:${ACCOUNT_ID}:event-bus/assignee-bus`,
        ),
      ).toBe("AWS::Events::EventBus");
    });

    it("classifies an Events Connection ARN as AWS::Events::Connection", () => {
      expect(
        classify(
          `arn:aws:events:us-east-1:${ACCOUNT_ID}:connection/assignee-conn/a1b2c3d4-5678-90ab-cdef-111122223333`,
        ),
      ).toBe("AWS::Events::Connection");
    });

    it("classifies an Events ApiDestination ARN as AWS::Events::ApiDestination", () => {
      expect(
        classify(
          `arn:aws:events:us-east-1:${ACCOUNT_ID}:api-destination/assignee-webhook/a1b2c3d4-5678-90ab-cdef-111122223333`,
        ),
      ).toBe("AWS::Events::ApiDestination");
    });
  });

  describe("GovCloud partition (aws-us-gov)", () => {
    it("classifies an Events EventBus ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:events:us-gov-west-1:${ACCOUNT_ID}:event-bus/gov-bus`,
        ),
      ).toBe("AWS::Events::EventBus");
    });

    it("classifies an Events Rule ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:events:us-gov-west-1:${ACCOUNT_ID}:rule/gov-rule`,
        ),
      ).toBe("AWS::Events::Rule");
    });
  });

  describe("China partition (aws-cn)", () => {
    it("classifies an Events Connection ARN in China partition correctly", () => {
      expect(
        classify(
          `arn:aws-cn:events:cn-north-1:${ACCOUNT_ID}:connection/cn-conn/a1b2c3d4-5678-90ab-cdef-111122223333`,
        ),
      ).toBe("AWS::Events::Connection");
    });
  });

  describe("fallback behaviour — backwards-compatibility guarantee", () => {
    it("falls back to AWS::Events::Rule when resource segment is empty", () => {
      // Pre-split, SERVICE_TYPE_MAP["events"] = AWS::Events::Rule was
      // the universal default. The subtype map's empty-key fallback
      // preserves that exact behaviour for unparseable inputs.
      expect(arnToCloudFormationType("events", "")).toBe("AWS::Events::Rule");
    });

    it("falls back to AWS::Events::Rule when resource segment is unrecognised", () => {
      // A future AWS Events subtype that this code doesn't yet know
      // about must not crash — it degrades to the legacy Rule default,
      // matching pre-split behaviour.
      expect(arnToCloudFormationType("events", "future-thing/my-thing")).toBe(
        "AWS::Events::Rule",
      );
    });

    it("falls back to AWS::Events::Rule for a malformed Events ARN (service-only resource part)", () => {
      expect(classify(`arn:aws:events:us-east-1:${ACCOUNT_ID}:`)).toBe(
        "AWS::Events::Rule",
      );
    });
  });

  describe("SERVICE_TYPE_MAP / SERVICE_SUBTYPE_MAP shape invariants", () => {
    it("removes `events` from SERVICE_TYPE_MAP (routed via subtype map now)", () => {
      expect(SERVICE_TYPE_MAP["events"]).toBeUndefined();
    });

    it("adds `events` to SERVICE_SUBTYPE_MAP with all four first-class subtypes + default", () => {
      const eventsSubtypes = SERVICE_SUBTYPE_MAP["events"];
      expect(eventsSubtypes).toBeDefined();
      expect(eventsSubtypes?.["rule"]).toBe("AWS::Events::Rule");
      expect(eventsSubtypes?.["event-bus"]).toBe("AWS::Events::EventBus");
      expect(eventsSubtypes?.["connection"]).toBe("AWS::Events::Connection");
      expect(eventsSubtypes?.["api-destination"]).toBe(
        "AWS::Events::ApiDestination",
      );
      // Empty-key default preserves pre-split AWS::Events::Rule behaviour.
      expect(eventsSubtypes?.[""]).toBe("AWS::Events::Rule");
    });
  });
});

describe("arn-type-map — regression coverage for non-events services", () => {
  it("still classifies S3 bucket ARNs correctly", () => {
    expect(classify("arn:aws:s3:::assignee-state")).toBe("AWS::S3::Bucket");
  });

  it("still classifies Lambda function ARNs correctly", () => {
    expect(
      classify(
        `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:assignee-worker`,
      ),
    ).toBe("AWS::Lambda::Function");
  });

  it("still classifies EC2 instance ARNs correctly", () => {
    expect(
      classify(
        `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:instance/i-0abc1234def567890`,
      ),
    ).toBe("AWS::EC2::Instance");
  });

  it("still classifies IAM role ARNs correctly", () => {
    // IAM is global — region slot is empty, account in slot 4.
    expect(classify(`arn:aws:iam::${ACCOUNT_ID}:role/assignee-operator`)).toBe(
      "AWS::IAM::Role",
    );
  });

  it("still classifies KMS key ARNs correctly (explicit casing override)", () => {
    expect(
      classify(
        `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/a1b2c3d4-5678-90ab-cdef-111122223333`,
      ),
    ).toBe("AWS::KMS::Key");
  });

  it("still classifies SQS queue ARNs correctly", () => {
    expect(classify(`arn:aws:sqs:us-east-1:${ACCOUNT_ID}:assignee-jobs`)).toBe(
      "AWS::SQS::Queue",
    );
  });

  it("still classifies logs log-group ARNs correctly", () => {
    expect(
      classify(
        `arn:aws:logs:us-east-1:${ACCOUNT_ID}:log-group:/aws/lambda/assignee-worker`,
      ),
    ).toBe("AWS::Logs::LogGroup");
  });

  it("still falls back to capitalised service name for unknown services", () => {
    expect(arnToCloudFormationType("customservice", "myresource")).toBe(
      "AWS::Customservice::Myresource",
    );
  });

  it("still uses the casing-override table for IoT / FSx / WAFv2", () => {
    // These would otherwise come out as AWS::Iot::Thing etc. (wrong).
    expect(arnToCloudFormationType("iot", "thing/my-thing")).toBe(
      "AWS::IoT::Thing",
    );
    expect(arnToCloudFormationType("fsx", "file-system/fs-123")).toBe(
      "AWS::FSx::File-system",
    );
    expect(arnToCloudFormationType("wafv2", "webacl/my-acl")).toBe(
      "AWS::WAFv2::Webacl",
    );
  });
});
