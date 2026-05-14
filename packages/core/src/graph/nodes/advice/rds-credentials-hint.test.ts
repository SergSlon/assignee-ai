/**
 * Tests for rdsCredentialsHint advisory (RG-1 / DF-E5 — Solution C).
 */

import { describe, it, expect } from "vitest";
import {
  rdsCredentialsHint,
  RDS_MASTER_USER_PASSWORD_REQUIRED,
} from "./rds-credentials-hint.js";
import { RDS_REQUIRED_PASSWORD_PLACEHOLDER } from "@/config/placeholder-passwords.js";

describe("rdsCredentialsHint", () => {
  it("emits advisory when RDS DBInstance has the placeholder password", () => {
    const hints = rdsCredentialsHint("AWS::RDS::DBInstance", {
      Engine: "postgres",
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(RDS_MASTER_USER_PASSWORD_REQUIRED);
    expect(hints[0]).toContain("--set MasterUserPassword=");
  });

  it("does NOT emit advisory when MasterUserPassword is a real value", () => {
    const hints = rdsCredentialsHint("AWS::RDS::DBInstance", {
      Engine: "postgres",
      MasterUserPassword: "secretpass123",
    });
    expect(hints).toHaveLength(0);
  });

  it("does NOT emit advisory when MasterUserPassword is absent", () => {
    const hints = rdsCredentialsHint("AWS::RDS::DBInstance", {
      Engine: "postgres",
    });
    expect(hints).toHaveLength(0);
  });

  it("does NOT emit advisory for non-RDS resource types", () => {
    const hints = rdsCredentialsHint("AWS::S3::Bucket", {
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    });
    expect(hints).toHaveLength(0);
  });

  it("advisory text mentions SecretsManager roadmap", () => {
    const hints = rdsCredentialsHint("AWS::RDS::DBInstance", {
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    });
    expect(hints[0]).toContain("SecretsManager");
  });
});
