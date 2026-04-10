import { PluginRegistry } from "./registry.js";
import { s3BucketPlugin } from "./plugins/s3-bucket.js";
import { ec2InstancePlugin } from "./plugins/ec2-instance.js";
import { rdsDbInstancePlugin } from "./plugins/rds-dbinstance.js";
import { lambdaFunctionPlugin } from "./plugins/lambda-function.js";
import { securityGroupPlugin } from "./plugins/security-group.js";
import { dynamodbTablePlugin } from "./plugins/dynamodb-table.js";
import { vpcPlugin } from "./plugins/vpc.js";
import { subnetPlugin } from "./plugins/subnet.js";
import { sqsQueuePlugin } from "./plugins/sqs-queue.js";
import { snsTopicPlugin } from "./plugins/sns-topic.js";
import { ssmParameterPlugin } from "./plugins/ssm-parameter.js";
import { iamRolePlugin } from "./plugins/iam-role.js";
import { ecsClusterPlugin } from "./plugins/ecs-cluster.js";
import { ecrRepositoryPlugin } from "./plugins/ecr-repository.js";
import { elbv2LoadBalancerPlugin } from "./plugins/elbv2-loadbalancer.js";
// Sprint F: Tier 1 resource plugins (Epic 25)
import { logGroupPlugin } from "./plugins/logs-loggroup.js";
import { internetGatewayPlugin } from "./plugins/ec2-internet-gateway.js";
import { routeTablePlugin } from "./plugins/ec2-route-table.js";
import { routePlugin } from "./plugins/ec2-route.js";
import { natGatewayPlugin } from "./plugins/ec2-nat-gateway.js";
// Sprint G: Tier 2 resource plugins (Epic 26)
import { apiGatewayV2Plugin } from "./plugins/apigatewayv2-api.js";
import { cloudWatchAlarmPlugin } from "./plugins/cloudwatch-alarm.js";
import { secretsManagerSecretPlugin } from "./plugins/secretsmanager-secret.js";
// A1 (2026-04-08): first-class EFS support
import { efsFileSystemPlugin } from "./plugins/efs-file-system.js";
import { efsMountTargetPlugin } from "./plugins/efs-mount-target.js";
// A8 (2026-04-08): EventBridge Rule first-class
import { eventsRulePlugin } from "./plugins/events-rule.js";
// A9 (2026-04-09): EventBridge custom event bus first-class
import { eventsEventBusPlugin } from "./plugins/events-eventbus.js";
// A10 (2026-04-09): SNS Subscription promoted out of CCAPI_FALLBACK_TYPES
import { snsSubscriptionPlugin } from "./plugins/sns-subscription.js";
// A11 (2026-04-09): KMS::Key first-class (symmetric customer-managed keys)
import { kmsKeyPlugin } from "./plugins/kms-key.js";
// A12 (2026-04-09): Events::Connection first-class (outbound HTTP auth)
import { eventsConnectionPlugin } from "./plugins/events-connection.js";
// A13 (2026-04-09): Events::ApiDestination first-class (outbound HTTP endpoint)
import { eventsApiDestinationPlugin } from "./plugins/events-apidestination.js";
// A14 (2026-04-09): CloudFront::Distribution first-class
import { cloudFrontDistributionPlugin } from "./plugins/cloudfront-distribution.js";
// (f) 2026-04-09 Task 4b: CloudFront::OriginAccessControl + S3::BucketPolicy
// first-class (unblocks static-website compound migration off SDK)
import { cloudFrontOriginAccessControlPlugin } from "./plugins/cloudfront-origin-access-control.js";
import { s3BucketPolicyPlugin } from "./plugins/s3-bucket-policy.js";
import { genericPlugin } from "./plugins/generic.js";

/**
 * The default pre-populated plugin registry for Assignee.ai.
 * Import this in graph nodes and CLI commands — do not instantiate a new PluginRegistry elsewhere.
 *
 * To add a new plugin:
 *   1. Create `plugins/<resource-name>.ts`
 *   2. Import it here and call `defaultPluginRegistry.register(yourPlugin)`
 *   Zero changes to graph nodes or CLI command files are required.
 */
export const defaultPluginRegistry = new PluginRegistry();
defaultPluginRegistry.register(s3BucketPlugin);
defaultPluginRegistry.register(ec2InstancePlugin);
defaultPluginRegistry.register(rdsDbInstancePlugin);
defaultPluginRegistry.register(lambdaFunctionPlugin);
defaultPluginRegistry.register(securityGroupPlugin);
defaultPluginRegistry.register(dynamodbTablePlugin);
defaultPluginRegistry.register(vpcPlugin);
defaultPluginRegistry.register(subnetPlugin);
defaultPluginRegistry.register(sqsQueuePlugin);
defaultPluginRegistry.register(snsTopicPlugin);
defaultPluginRegistry.register(ssmParameterPlugin);
defaultPluginRegistry.register(iamRolePlugin);
defaultPluginRegistry.register(ecsClusterPlugin);
defaultPluginRegistry.register(ecrRepositoryPlugin);
defaultPluginRegistry.register(elbv2LoadBalancerPlugin);
// Sprint F: Tier 1 resources (Epic 25)
defaultPluginRegistry.register(logGroupPlugin);
defaultPluginRegistry.register(internetGatewayPlugin);
defaultPluginRegistry.register(routeTablePlugin);
defaultPluginRegistry.register(routePlugin);
defaultPluginRegistry.register(natGatewayPlugin);
// Sprint G: Tier 2 resources (Epic 26)
defaultPluginRegistry.register(apiGatewayV2Plugin);
defaultPluginRegistry.register(cloudWatchAlarmPlugin);
defaultPluginRegistry.register(secretsManagerSecretPlugin);
// A1 (2026-04-08): first-class EFS support
defaultPluginRegistry.register(efsFileSystemPlugin);
defaultPluginRegistry.register(efsMountTargetPlugin);
// A8 (2026-04-08): EventBridge Rule first-class
defaultPluginRegistry.register(eventsRulePlugin);
// A9 (2026-04-09): EventBridge custom event bus first-class
defaultPluginRegistry.register(eventsEventBusPlugin);
// A10 (2026-04-09): SNS Subscription first-class
defaultPluginRegistry.register(snsSubscriptionPlugin);
// A11 (2026-04-09): KMS::Key first-class
defaultPluginRegistry.register(kmsKeyPlugin);
// A12 (2026-04-09): Events::Connection first-class
defaultPluginRegistry.register(eventsConnectionPlugin);
// A13 (2026-04-09): Events::ApiDestination first-class
defaultPluginRegistry.register(eventsApiDestinationPlugin);
// A14 (2026-04-09): CloudFront::Distribution first-class
defaultPluginRegistry.register(cloudFrontDistributionPlugin);
// (f) 2026-04-09 Task 4b: OAC + BucketPolicy for static-website compound
defaultPluginRegistry.register(cloudFrontOriginAccessControlPlugin);
defaultPluginRegistry.register(s3BucketPolicyPlugin);
defaultPluginRegistry.register(genericPlugin);

export { PluginRegistry };
export { s3BucketPlugin } from "./plugins/s3-bucket.js";
export { ec2InstancePlugin } from "./plugins/ec2-instance.js";
export { rdsDbInstancePlugin } from "./plugins/rds-dbinstance.js";
export {
  lambdaFunctionPlugin,
  sortedRuntimes as lambdaRuntimes,
} from "./plugins/lambda-function.js";
export { securityGroupPlugin } from "./plugins/security-group.js";
export { dynamodbTablePlugin } from "./plugins/dynamodb-table.js";
export { vpcPlugin } from "./plugins/vpc.js";
export { subnetPlugin } from "./plugins/subnet.js";
export { sqsQueuePlugin } from "./plugins/sqs-queue.js";
export { snsTopicPlugin } from "./plugins/sns-topic.js";
export { ssmParameterPlugin } from "./plugins/ssm-parameter.js";
export { iamRolePlugin } from "./plugins/iam-role.js";
export { ecsClusterPlugin } from "./plugins/ecs-cluster.js";
export { ecrRepositoryPlugin } from "./plugins/ecr-repository.js";
export { elbv2LoadBalancerPlugin } from "./plugins/elbv2-loadbalancer.js";
// Sprint F: Tier 1 resources (Epic 25)
export { logGroupPlugin } from "./plugins/logs-loggroup.js";
export { internetGatewayPlugin } from "./plugins/ec2-internet-gateway.js";
export { routeTablePlugin } from "./plugins/ec2-route-table.js";
export { routePlugin } from "./plugins/ec2-route.js";
export { natGatewayPlugin } from "./plugins/ec2-nat-gateway.js";
// Sprint G: Tier 2 resources (Epic 26)
export { apiGatewayV2Plugin } from "./plugins/apigatewayv2-api.js";
export { cloudWatchAlarmPlugin } from "./plugins/cloudwatch-alarm.js";
export { secretsManagerSecretPlugin } from "./plugins/secretsmanager-secret.js";
// A1 (2026-04-08): first-class EFS support
export { efsFileSystemPlugin } from "./plugins/efs-file-system.js";
export { efsMountTargetPlugin } from "./plugins/efs-mount-target.js";
// A8 (2026-04-08): EventBridge Rule first-class
export { eventsRulePlugin } from "./plugins/events-rule.js";
// A9 (2026-04-09): EventBridge custom event bus first-class
export { eventsEventBusPlugin } from "./plugins/events-eventbus.js";
// A10 (2026-04-09): SNS Subscription first-class
export { snsSubscriptionPlugin } from "./plugins/sns-subscription.js";
// A11 (2026-04-09): KMS::Key first-class
export { kmsKeyPlugin } from "./plugins/kms-key.js";
// A12 (2026-04-09): Events::Connection first-class
export { eventsConnectionPlugin } from "./plugins/events-connection.js";
// A13 (2026-04-09): Events::ApiDestination first-class
export { eventsApiDestinationPlugin } from "./plugins/events-apidestination.js";
// A14 (2026-04-09): CloudFront::Distribution first-class
export { cloudFrontDistributionPlugin } from "./plugins/cloudfront-distribution.js";
// (f) 2026-04-09 Task 4b: OAC + BucketPolicy for static-website compound
export { cloudFrontOriginAccessControlPlugin } from "./plugins/cloudfront-origin-access-control.js";
export { s3BucketPolicyPlugin } from "./plugins/s3-bucket-policy.js";
export { genericPlugin } from "./plugins/generic.js";
export type {
  ResourcePlugin,
  ResourceField,
  FieldQuestion,
  FetcherContext,
  QuestionType,
  ShowIfCondition,
  CfnOutput,
} from "./types.js";
export { QuestionTypeName } from "./types.js";
export { FieldLabel } from "./field-labels.js";

// Story 25.6: LogGroup co-provisioning
export {
  collectCompanionResources,
  type CollectCompanionOptions,
  type PlannedResource,
} from "./companion-resources.js";
