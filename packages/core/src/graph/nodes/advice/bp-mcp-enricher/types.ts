/**
 * Shared constants + severity mapping for bp-mcp-enricher queries.
 */
import type { BPSeverity } from "@assignee/best-practices";

export const MCP_BP_TIMEOUT_MS = 3_000;

/** Resource types that should trigger CheckStorageEncryption. */
export const STORAGE_RESOURCE_TYPES = new Set([
  "AWS::S3::Bucket",
  "AWS::RDS::DBInstance",
  "AWS::DynamoDB::Table",
  "AWS::EFS::FileSystem",
  "AWS::Logs::LogGroup",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::SecretsManager::Secret",
  "AWS::ECR::Repository",
]);

/** Resource types that should trigger CheckNetworkSecurity. */
export const NETWORK_RESOURCE_TYPES = new Set([
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudFront::Distribution",
  "AWS::EC2::Instance",
  "AWS::EC2::SecurityGroup",
  "AWS::RDS::DBInstance",
]);

export function mapMcpSeverity(severity: string | undefined): BPSeverity {
  switch (severity?.toUpperCase()) {
    case "CRITICAL":
      return "CRITICAL";
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
      return "MEDIUM";
    default:
      return "INFO";
  }
}
