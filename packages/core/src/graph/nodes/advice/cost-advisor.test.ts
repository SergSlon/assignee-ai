import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { costAlternatives } from "./cost-advisor/orchestrator.js";

describe("costAlternatives", () => {
  describe("EC2", () => {
    it("suggests ARM alternative for t3 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
      });
      expect(hints.some((h) => h.includes("t4g.micro"))).toBe(true);
    });

    it("suggests ARM alternative for m5 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "m5.large",
      });
      expect(hints.some((h) => h.includes("m6g.large"))).toBe(true);
    });

    it("suggests ARM alternative for c5 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "c5.xlarge",
      });
      expect(hints.some((h) => h.includes("c6g.xlarge"))).toBe(true);
    });

    it("suggests spot for burstable instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
      });
      expect(hints.some((h) => h.includes("Spot Instances"))).toBe(true);
    });

    it("returns empty for missing InstanceType", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        ImageId: "ami-abc123",
      });
      expect(hints).toHaveLength(0);
    });
  });

  describe("RDS", () => {
    it("suggests smaller class for r5/r6g instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceClass: "db.r5.large",
        Engine: "postgres",
      });
      expect(hints.some((h) => h.includes("db.t3.medium"))).toBe(true);
    });

    it("notes Multi-AZ cost doubling", () => {
      const hints = costAlternatives(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceClass: "db.t3.micro",
        MultiAZ: true,
      });
      expect(hints.some((h) => h.includes("doubles the instance cost"))).toBe(
        true,
      );
    });
  });

  describe("S3", () => {
    it("suggests lifecycle rules when missing", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
      });
      expect(hints.some((h) => h.includes("lifecycle rules"))).toBe(true);
    });

    it("does not suggest lifecycle when already configured", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        LifecycleConfiguration: { Rules: [] },
      });
      // Lifecycle hint still references "lifecycle" — but IT/replication
      // hints don't. Assert the lifecycle-rules suggestion specifically
      // is silenced.
      expect(hints.some((h) => h.includes("lifecycle rules"))).toBe(false);
    });

    // (f) 2026-04-09 — IT decomposer reminder
    it("mentions IT break-even when IntelligentTieringConfigurations is set", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        IntelligentTieringConfigurations: [
          { Id: "ArchiveConfig", Status: "Enabled" },
        ],
      });
      expect(
        hints.some(
          (h) =>
            h.includes("Intelligent-Tiering") &&
            h.includes("128KB") &&
            h.includes("30 days") &&
            h.includes("monitoring fee"),
        ),
      ).toBe(true);
    });

    it("does NOT mention IT when IntelligentTieringConfigurations is absent", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
      });
      expect(hints.some((h) => h.includes("Intelligent-Tiering"))).toBe(false);
    });

    it("does NOT mention IT when IntelligentTieringConfigurations is empty", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        IntelligentTieringConfigurations: [],
      });
      expect(hints.some((h) => h.includes("Intelligent-Tiering"))).toBe(false);
    });

    // (f) 2026-04-09 — Replication decomposer reminder
    it("mentions inter-region DTO gap when ReplicationConfiguration has rules", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        ReplicationConfiguration: {
          Role: "arn:aws:iam::123456789012:role/r",
          Rules: [
            {
              Destination: {
                Bucket: "arn:aws:s3:::dest",
              },
              Status: "Enabled",
            },
          ],
        },
      });
      expect(
        hints.some(
          (h) =>
            h.includes("Cross-region replication") &&
            h.includes("inter-region data transfer") &&
            h.includes("not shown separately"),
        ),
      ).toBe(true);
    });

    it("does NOT mention replication DTO when ReplicationConfiguration has no rules", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        ReplicationConfiguration: {
          Role: "arn:aws:iam::123456789012:role/r",
          Rules: [],
        },
      });
      expect(hints.some((h) => h.includes("Cross-region replication"))).toBe(
        false,
      );
    });

    it("does NOT mention replication DTO when ReplicationConfiguration is absent", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
      });
      expect(hints.some((h) => h.includes("Cross-region replication"))).toBe(
        false,
      );
    });
  });

  describe("Lambda", () => {
    it("suggests lower memory when > 512MB", () => {
      const hints = costAlternatives(RESOURCE_TYPES.LAMBDA_FUNCTION, {
        FunctionName: "my-fn",
        MemorySize: 1024,
      });
      expect(hints.some((h) => h.includes("1024MB"))).toBe(true);
    });

    it("does not suggest lower memory when <= 512MB", () => {
      const hints = costAlternatives(RESOURCE_TYPES.LAMBDA_FUNCTION, {
        FunctionName: "my-fn",
        MemorySize: 256,
      });
      expect(hints).toHaveLength(0);
    });
  });

  describe("free resources", () => {
    it("returns empty for IAM Role", () => {
      const hints = costAlternatives(RESOURCE_TYPES.IAM_ROLE, {
        RoleName: "my-role",
      });
      expect(hints).toHaveLength(0);
    });
  });

  // A1 follow-up (2026-04-08): EFS file system + mount target cost hints.
  describe("EFS", () => {
    it("warns about provisioned throughput with an explicit MiB/s", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {
        ThroughputMode: "provisioned",
        ProvisionedThroughputInMibps: 100,
      });
      // Wording matches the decomposer's FIXED provisioned-throughput
      // line: $6/MiB-s-month baseline, ~50 MiB/s switchback threshold.
      expect(
        hints.some(
          (h) =>
            h.includes("provisioned") &&
            h.includes("100 MiB/s") &&
            h.includes("$6/MiB-s-month") &&
            h.includes("bursting / elastic") &&
            h.includes("50 MiB/s"),
        ),
      ).toBe(true);
    });

    it("warns about provisioned throughput even without a MiB/s value", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {
        ThroughputMode: "provisioned",
      });
      expect(
        hints.some(
          (h) =>
            h.includes("ThroughputMode=provisioned") &&
            h.includes("$6/MiB-s-month"),
        ),
      ).toBe(true);
    });

    it("does NOT warn about provisioned throughput when mode is elastic", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {
        ThroughputMode: "elastic",
      });
      expect(hints.some((h) => h.includes("ThroughputMode"))).toBe(false);
    });

    it("mentions One Zone savings when AvailabilityZoneName is set", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {
        AvailabilityZoneName: "us-east-1a",
      });
      expect(
        hints.some((h) => h.includes("One Zone") && h.includes("us-east-1a")),
      ).toBe(true);
    });

    it("suggests One Zone as an opt-in when AvailabilityZoneName is absent", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {});
      expect(
        hints.some((h) => h.includes("Regional") && h.includes("One Zone")),
      ).toBe(true);
    });

    it("always mentions lifecycle tiering for cold data", () => {
      const hints = costAlternatives("AWS::EFS::FileSystem", {});
      expect(
        hints.some((h) => h.includes("Lifecycle") && h.includes("Archive")),
      ).toBe(true);
    });

    it("MountTarget advice calls out the billing model", () => {
      const hints = costAlternatives("AWS::EFS::MountTarget", {});
      expect(
        hints.some(
          (h) => h.includes("mount target") && h.includes("FileSystem"),
        ),
      ).toBe(true);
    });
  });

  // (f) 2026-04-09: SQS cross-region DTO reminder + CloudFront
  // invalidation trap — wired from decomposer line item descriptions.
  describe("SQS", () => {
    it("always mentions the cross-region DTO caveat for standard queues", () => {
      const hints = costAlternatives(RESOURCE_TYPES.SQS_QUEUE, {
        QueueName: "orders-queue",
      });
      expect(
        hints.some(
          (h) =>
            h.includes("In-region consumers are free") &&
            h.includes("another region") &&
            h.includes("multi-region consumers"),
        ),
      ).toBe(true);
    });

    it("mentions the cross-region DTO caveat AND the FIFO surcharge for FIFO queues", () => {
      const hints = costAlternatives(RESOURCE_TYPES.SQS_QUEUE, {
        QueueName: "orders.fifo",
        FifoQueue: true,
      });
      expect(hints.some((h) => h.includes("FIFO queues cost 25%"))).toBe(true);
      expect(
        hints.some((h) => h.includes("In-region consumers are free")),
      ).toBe(true);
    });
  });

  describe("CloudFront Distribution", () => {
    it("always surfaces the invalidation trap reminder", () => {
      const hints = costAlternatives(RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION, {
        DistributionConfig: {
          Enabled: true,
          DefaultCacheBehavior: {
            TargetOriginId: "primary",
            ViewerProtocolPolicy: "redirect-to-https",
          },
          Origins: [{ Id: "primary", DomainName: "origin.example.com" }],
        },
      });
      expect(
        hints.some(
          (h) =>
            h.includes("1,000 invalidation paths/month") &&
            h.includes("$0.005") &&
            h.includes("cache-busting filenames"),
        ),
      ).toBe(true);
    });
  });

  // A8 (2026-04-08): EventBridge Rule cost hints.
  describe("EventBridge Rule", () => {
    it("default bus mentions free rule evaluation + target workload cost", () => {
      const hints = costAlternatives("AWS::Events::Rule", {
        ScheduleExpression: "rate(1 hour)",
      });
      expect(hints.some((h) => h.includes("default bus is free"))).toBe(true);
    });

    it("custom bus calls out $1/million publish cost", () => {
      const hints = costAlternatives("AWS::Events::Rule", {
        EventBusName: "my-bus",
      });
      expect(
        hints.some((h) => h.includes('"my-bus"') && h.includes("$1.00")),
      ).toBe(true);
    });

    it("rate(1 minute) surfaces a ~43800/month invocation estimate", () => {
      const hints = costAlternatives("AWS::Events::Rule", {
        ScheduleExpression: "rate(1 minute)",
      });
      // 60 * 24 * 30.44 / 1 ≈ 43,834
      expect(
        hints.some((h) => h.includes("rate(1 minute)") && /43,?\d{3}/.test(h)),
      ).toBe(true);
    });

    it("rate(1 hour) surfaces a ~731/month invocation estimate", () => {
      const hints = costAlternatives("AWS::Events::Rule", {
        ScheduleExpression: "rate(1 hour)",
      });
      // 24 * 30.44 ≈ 731
      expect(
        hints.some((h) => h.includes("rate(1 hour)") && /7\d{2}/.test(h)),
      ).toBe(true);
    });

    it("cron expressions do not trip the rate() frequency estimator", () => {
      const hints = costAlternatives("AWS::Events::Rule", {
        ScheduleExpression: "cron(0 12 * * ? *)",
      });
      // cron() is not parsed — estimator stays silent for cron expressions
      expect(hints.some((h) => h.includes("fires approximately"))).toBe(false);
    });

    it("always mentions DeadLetterConfig + RetryPolicy as a cost-control lever", () => {
      const hints = costAlternatives("AWS::Events::Rule", {});
      expect(
        hints.some(
          (h) => h.includes("DeadLetterConfig") && h.includes("185 retries"),
        ),
      ).toBe(true);
    });
  });

  // ── Story 46.3: enriched price labels ────────────────────────────────────

  describe("enriched advisory prices", () => {
    it('renders "(live)" suffix when an enriched price map is supplied', async () => {
      const { AdvisoryPriceId } = await import("@/pricing/advisory-prices.js");
      // Synthesize an enriched map with a live NAT Gateway price.
      const enriched = new Map([
        [
          AdvisoryPriceId.NAT_GATEWAY_MONTHLY,
          {
            value: 32.85,
            label: "~$32.85/mo (live)",
            source: "mcp" as const,
          },
        ],
      ]);

      const hints = costAlternatives("AWS::EC2::NatGateway", {}, enriched);

      // The hint should now embed the "(live)"-tagged label, not the
      // bare constant.
      expect(
        hints.some(
          (h) => h.includes("~$32.85/mo (live)") && h.includes("NAT Gateway"),
        ),
      ).toBe(true);
    });

    it('falls back to "(estimated)" suffix when the enriched map is empty', async () => {
      const enriched = new Map();
      const hints = costAlternatives("AWS::EC2::NatGateway", {}, enriched);

      // Empty map → enrichedLabel synthesizes the fallback formatter,
      // producing "~$X.XX/mo (estimated)" via formatLabelWithSource.
      expect(
        hints.some(
          (h) => h.includes("(estimated)") && h.includes("NAT Gateway"),
        ),
      ).toBe(true);
    });

    it("falls back consistently when enriched map is omitted entirely (legacy callsite)", () => {
      const hints = costAlternatives("AWS::EC2::NatGateway", {});
      // Should not throw, should produce the (estimated) suffix.
      expect(
        hints.some(
          (h) => h.includes("(estimated)") && h.includes("NAT Gateway"),
        ),
      ).toBe(true);
    });
  });
});
