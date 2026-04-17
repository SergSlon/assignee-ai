/**
 * Concrete destroy strategies — lifted from apps/cli by Story 50-4 so
 * both the CLI and MCP server can register identical behavior.
 *
 * Each strategy file encapsulates the per-resource-type pre/post destroy
 * logic. The registry in either app composes them with
 * `arnIdentifierStrategies` + `slowDeleteStrategies` (shared flag-only
 * defaults) — see default-strategies.ts.
 */

export { dynamodbTableStrategy } from "./dynamodb-table.js";
export { ec2EipStrategy } from "./ec2-eip.js";
export { ec2InternetGatewayStrategy } from "./ec2-internetgateway.js";
export { ec2RouteTableStrategy } from "./ec2-routetable.js";
export { efsFileSystemStrategy } from "./efs-filesystem.js";
export { elbv2LoadBalancerStrategy } from "./elbv2-loadbalancer.js";
export { s3BucketStrategy } from "./s3-bucket.js";
export { cloudfrontDistributionStrategy } from "./cloudfront-distribution.js";
export { sqsQueueStrategy } from "./sqs-queue.js";
