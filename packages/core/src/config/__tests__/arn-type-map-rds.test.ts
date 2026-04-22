/**
 * Epic 94 P1 (D-03) — RDS DBSubnetGroup arn-type-map split.
 *
 * Pre-fix: `SERVICE_TYPE_MAP.rds = AWS::RDS::DBInstance` forced every
 * `arn:aws:rds:...` ARN to classify as `AWS::RDS::DBInstance` because
 * `arnToCloudFormationType` consults SERVICE_SUBTYPE_MAP first, then
 * SERVICE_TYPE_MAP as a fallback, but the simple-map entry meant
 * the subtype dispatch never got an opportunity to run for `rds`.
 *
 * Post-fix: `rds` is lifted into SERVICE_SUBTYPE_MAP with entries
 * for `db` (DBInstance), `subgrp` (DBSubnetGroup), and a `""`
 * fallback that preserves the pre-split default of DBInstance for
 * any future / malformed RDS resource segment.
 *
 * Mirrors the Events subtype split test layout in
 * `arn-type-map.test.ts` so the pattern stays consistent.
 */

import { describe, it, expect } from "vitest";
import {
  arnToCloudFormationType,
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
} from "../arn-type-map.js";

const ACCOUNT_ID = "210987654321";

function classify(arn: string): string {
  const parts = arn.split(":");
  // Rejoin slot 5 onwards so the subtype dispatcher sees the real
  // resource segment shape (RDS ARNs use `db:<name>` / `subgrp:<name>`).
  const resourcePart = parts.slice(5).join(":");
  return arnToCloudFormationType(parts[2] ?? "", resourcePart);
}

describe("arn-type-map — RDS subtype split (Story e94.P1, D-03)", () => {
  describe("commercial partition (aws) — every documented RDS subtype", () => {
    it("classifies an RDS DBInstance ARN as AWS::RDS::DBInstance", () => {
      expect(
        classify(`arn:aws:rds:us-east-1:${ACCOUNT_ID}:db:prod-primary`),
      ).toBe("AWS::RDS::DBInstance");
    });

    it("classifies an RDS DBSubnetGroup ARN as AWS::RDS::DBSubnetGroup (D-03 proof)", () => {
      expect(
        classify(
          `arn:aws:rds:us-east-1:${ACCOUNT_ID}:subgrp:three-tier-subnet-group`,
        ),
      ).toBe("AWS::RDS::DBSubnetGroup");
    });

    it("classifies an RDS DBSecurityGroup ARN as AWS::RDS::DBSecurityGroup", () => {
      // EC2-Classic legacy shape; still carried in AWS's ARN
      // reference and surfaces in long-lived accounts.
      expect(
        classify(`arn:aws:rds:us-east-1:${ACCOUNT_ID}:secgrp:legacy-sg`),
      ).toBe("AWS::RDS::DBSecurityGroup");
    });

    it("classifies an RDS DBParameterGroup ARN as AWS::RDS::DBParameterGroup", () => {
      expect(
        classify(`arn:aws:rds:us-east-1:${ACCOUNT_ID}:pg:prod-pg-mysql8`),
      ).toBe("AWS::RDS::DBParameterGroup");
    });

    it("classifies an RDS DBSnapshot ARN as AWS::RDS::DBSnapshot", () => {
      expect(
        classify(
          `arn:aws:rds:us-east-1:${ACCOUNT_ID}:snapshot:rds:prod-daily-2026-04-22`,
        ),
      ).toBe("AWS::RDS::DBSnapshot");
    });

    it("classifies an RDS DBCluster ARN as AWS::RDS::DBCluster", () => {
      expect(
        classify(
          `arn:aws:rds:us-east-1:${ACCOUNT_ID}:cluster:aurora-prod-writer`,
        ),
      ).toBe("AWS::RDS::DBCluster");
    });

    it("classifies an RDS DBClusterSnapshot ARN as AWS::RDS::DBClusterSnapshot", () => {
      expect(
        classify(
          `arn:aws:rds:us-east-1:${ACCOUNT_ID}:cluster-snapshot:aurora-prod-2026-04-22`,
        ),
      ).toBe("AWS::RDS::DBClusterSnapshot");
    });

    it("classifies an RDS OptionGroup ARN as AWS::RDS::OptionGroup", () => {
      expect(
        classify(`arn:aws:rds:us-east-1:${ACCOUNT_ID}:og:mysql-prod-og`),
      ).toBe("AWS::RDS::OptionGroup");
    });
  });

  describe("GovCloud partition (aws-us-gov)", () => {
    it("classifies an RDS DBInstance ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:rds:us-gov-west-1:${ACCOUNT_ID}:db:gov-primary`,
        ),
      ).toBe("AWS::RDS::DBInstance");
    });

    it("classifies an RDS DBSubnetGroup ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:rds:us-gov-west-1:${ACCOUNT_ID}:subgrp:gov-subnets`,
        ),
      ).toBe("AWS::RDS::DBSubnetGroup");
    });

    it("classifies an RDS DBCluster ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:rds:us-gov-west-1:${ACCOUNT_ID}:cluster:gov-aurora`,
        ),
      ).toBe("AWS::RDS::DBCluster");
    });

    it("classifies an RDS OptionGroup ARN in GovCloud correctly", () => {
      expect(
        classify(
          `arn:aws-us-gov:rds:us-gov-west-1:${ACCOUNT_ID}:og:gov-mysql-og`,
        ),
      ).toBe("AWS::RDS::OptionGroup");
    });
  });

  describe("China partition (aws-cn)", () => {
    it("classifies an RDS DBSubnetGroup ARN in China correctly", () => {
      expect(
        classify(`arn:aws-cn:rds:cn-north-1:${ACCOUNT_ID}:subgrp:cn-subnets`),
      ).toBe("AWS::RDS::DBSubnetGroup");
    });

    it("classifies an RDS DBParameterGroup ARN in China correctly", () => {
      expect(
        classify(`arn:aws-cn:rds:cn-north-1:${ACCOUNT_ID}:pg:cn-pg-mysql`),
      ).toBe("AWS::RDS::DBParameterGroup");
    });

    it("classifies an RDS DBSnapshot ARN in China correctly", () => {
      expect(
        classify(
          `arn:aws-cn:rds:cn-north-1:${ACCOUNT_ID}:snapshot:cn-daily-2026-04-22`,
        ),
      ).toBe("AWS::RDS::DBSnapshot");
    });
  });

  describe("fallback — unknown RDS resource segment", () => {
    it("unknown future segment still classifies as AWS::RDS::DBInstance", () => {
      // A hypothetical future RDS resource segment (e.g. `proxy` for
      // RDS Proxy — which actually uses a different ARN shape today)
      // must not crash the classifier — it keeps the pre-split default
      // behaviour. This invariant matches the Events split's
      // `"": RESOURCE_TYPES.EVENTS_RULE` fallback.
      expect(
        classify(`arn:aws:rds:us-east-1:${ACCOUNT_ID}:future-subtype:whatever`),
      ).toBe("AWS::RDS::DBInstance");
    });

    it("empty resource segment still classifies as AWS::RDS::DBInstance", () => {
      // Malformed ARN with empty resource-type slot.
      expect(arnToCloudFormationType("rds", "")).toBe("AWS::RDS::DBInstance");
    });
  });

  describe("map structure invariants", () => {
    it("`rds` is NOT in SERVICE_TYPE_MAP (moved to subtype map)", () => {
      // The key was lifted to SERVICE_SUBTYPE_MAP — a surviving entry
      // in SERVICE_TYPE_MAP would short-circuit the subtype dispatch
      // and re-introduce D-03.
      expect(SERVICE_TYPE_MAP["rds"]).toBeUndefined();
    });

    it("`rds` subtype map covers every documented RDS subtype + fallback", () => {
      const rdsSubtypes = SERVICE_SUBTYPE_MAP["rds"];
      expect(rdsSubtypes).toBeDefined();
      expect(rdsSubtypes!["db"]).toBe("AWS::RDS::DBInstance");
      expect(rdsSubtypes!["subgrp"]).toBe("AWS::RDS::DBSubnetGroup");
      expect(rdsSubtypes!["secgrp"]).toBe("AWS::RDS::DBSecurityGroup");
      expect(rdsSubtypes!["pg"]).toBe("AWS::RDS::DBParameterGroup");
      expect(rdsSubtypes!["snapshot"]).toBe("AWS::RDS::DBSnapshot");
      expect(rdsSubtypes!["cluster"]).toBe("AWS::RDS::DBCluster");
      expect(rdsSubtypes!["cluster-snapshot"]).toBe(
        "AWS::RDS::DBClusterSnapshot",
      );
      expect(rdsSubtypes!["og"]).toBe("AWS::RDS::OptionGroup");
      expect(rdsSubtypes![""]).toBe("AWS::RDS::DBInstance");
    });
  });
});
