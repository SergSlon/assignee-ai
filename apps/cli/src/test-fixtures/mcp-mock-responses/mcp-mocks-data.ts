// AUTO-GENERATED barrel for split mcp-mock-responses fixture (story 48-10).
// Re-assembles original section objects + McpMocks + RawSchemas + RawSchemasByType.
import { unwrapSchemaPayload } from "./_helpers.js";
import { s3Bucket as sch_s3Bucket } from "./schema-s3-bucket.js";
import { ec2Instance as sch_ec2Instance } from "./schema-ec2-instance.js";
import { lambdaFunction as sch_lambdaFunction } from "./schema-lambda-function.js";
import { rdsDbInstance as sch_rdsDbInstance } from "./schema-rds-db-instance.js";
import { iamRole as sch_iamRole } from "./schema-iam-role.js";
import { dynamoDbTable as sch_dynamoDbTable } from "./schema-dynamodb-table.js";
import { ssmParameter as sch_ssmParameter } from "./schema-ssm-parameter.js";
import { securityGroup as sch_securityGroup } from "./schema-security-group.js";
import { vpc as sch_vpc } from "./schema-vpc.js";
import { subnet as sch_subnet } from "./schema-subnet.js";
import { sqsQueue as sch_sqsQueue } from "./schema-sqs-queue.js";
import { snsTopic as sch_snsTopic } from "./schema-sns-topic.js";
import { ecsCluster as sch_ecsCluster } from "./schema-ecs-cluster.js";
import { ecrRepository as sch_ecrRepository } from "./schema-ecr-repository.js";
import { elbv2LoadBalancer as sch_elbv2LoadBalancer } from "./schema-elbv2-load-balancer.js";
import { generic as sch_generic, empty as sch_empty } from "./schema-shared.js";
import {
  s3Storage as prc_s3Storage,
  s3PutRequests as prc_s3PutRequests,
  s3GetRequests as prc_s3GetRequests,
  s3DataTransfer as prc_s3DataTransfer,
} from "./pricing-s3.js";
import {
  ec2T3Micro as prc_ec2T3Micro,
  ec2T3Small as prc_ec2T3Small,
  ec2M5Large as prc_ec2M5Large,
} from "./pricing-ec2-instances.js";
import {
  rdsT3MicroPostgres as prc_rdsT3MicroPostgres,
  rdsR6gLargeAuroraPostgres as prc_rdsR6gLargeAuroraPostgres,
  rdsT3MicroPostgresMultiAZ as prc_rdsT3MicroPostgresMultiAZ,
} from "./pricing-rds-postgres.js";
import {
  rdsT3MicroMysql as prc_rdsT3MicroMysql,
  rdsR6gLargeAuroraMysql as prc_rdsR6gLargeAuroraMysql,
  rdsT3MicroMariadb as prc_rdsT3MicroMariadb,
} from "./pricing-rds-mysql.js";
import { ssmParameter as prc_ssmParameter } from "./pricing-ssm.js";
import {
  ebsGp3Storage as prc_ebsGp3Storage,
  publicIpv4 as prc_publicIpv4,
  dataTransferOut as prc_dataTransferOut,
} from "./pricing-ec2-ancillary.js";
import {
  rdsStorageGp3 as prc_rdsStorageGp3,
  rdsBackupStorage as prc_rdsBackupStorage,
} from "./pricing-rds-storage.js";
import {
  lambdaRequests as prc_lambdaRequests,
  lambdaDuration as prc_lambdaDuration,
} from "./pricing-lambda.js";
import { cloudWatchLogs as prc_cloudWatchLogs } from "./pricing-cloudwatch.js";
import {
  sqsStandardRequests as prc_sqsStandardRequests,
  sqsFifoRequests as prc_sqsFifoRequests,
} from "./pricing-sqs.js";
import { snsPublishes as prc_snsPublishes } from "./pricing-sns.js";
import { ecrStorage as prc_ecrStorage } from "./pricing-ecr.js";
import {
  elbv2AlbHourly as prc_elbv2AlbHourly,
  elbv2AlbLcu as prc_elbv2AlbLcu,
} from "./pricing-elbv2.js";
import {
  emptyData as prc_emptyData,
  zeroPrice as prc_zeroPrice,
  emptyResponse as prc_emptyResponse,
  malformedJson as prc_malformedJson,
} from "./pricing-shared.js";
import {
  s3BucketName as dsr_s3BucketName,
  ec2InstanceType as dsr_ec2InstanceType,
  lambdaRuntime as dsr_lambdaRuntime,
  rdsEngine as dsr_rdsEngine,
  unstructuredWithUrl as dsr_unstructuredWithUrl,
  emptyResults as dsr_emptyResults,
  noResultsText as dsr_noResultsText,
  nullResponse as dsr_nullResponse,
} from "./doc-search.js";
import { s3BucketName as drs_s3BucketName } from "./doc-read-sections-s3.js";
import { ec2InstanceType as drs_ec2InstanceType } from "./doc-read-sections-ec2.js";
import { lambdaRuntime as drs_lambdaRuntime } from "./doc-read-sections-lambda.js";
import { rdsEngine as drs_rdsEngine } from "./doc-read-sections-rds.js";
import { dynamoDbBillingMode as drs_dynamoDbBillingMode } from "./doc-read-sections-dynamodb.js";
import {
  longContent as drs_longContent,
  withNotFoundNote as drs_withNotFoundNote,
  noMatchingSections as drs_noMatchingSections,
  serverError as drs_serverError,
} from "./doc-read-sections-shared.js";
import {
  s3BucketFull as drf_s3BucketFull,
  lambdaFunctionFull as drf_lambdaFunctionFull,
  emptyPage as drf_emptyPage,
} from "./doc-read-full.js";
import { s3BucketAllowed as iam_s3BucketAllowed } from "./iam-s3.js";
import { ec2InstancePartialDeny as iam_ec2InstancePartialDeny } from "./iam-ec2.js";
import { lambdaFunctionAllowed as iam_lambdaFunctionAllowed } from "./iam-lambda.js";
import { ssmParameterAllowed as iam_ssmParameterAllowed } from "./iam-ssm.js";
import { securityGroupAllowed as iam_securityGroupAllowed } from "./iam-security-group.js";
import { vpcAllowed as iam_vpcAllowed } from "./iam-vpc.js";
import { dynamoDbTableAllowed as iam_dynamoDbTableAllowed } from "./iam-dynamodb.js";
import { elbv2LoadBalancerAllowed as iam_elbv2LoadBalancerAllowed } from "./iam-elbv2.js";
import {
  s3BucketPosture as sec_s3BucketPosture,
  noFindings as sec_noFindings,
  serviceDisabled as sec_serviceDisabled,
  checkServicesAllEnabled as sec_checkServicesAllEnabled,
  checkServicesDisabled as sec_checkServicesDisabled,
} from "./security-posture.js";
import {
  s3BucketCost as bil_s3BucketCost,
  multiResourceCost as bil_multiResourceCost,
  noCostData as bil_noCostData,
  costForecast as bil_costForecast,
} from "./billing.js";

const schemaResponses = {
  s3Bucket: sch_s3Bucket,
  ec2Instance: sch_ec2Instance,
  lambdaFunction: sch_lambdaFunction,
  rdsDbInstance: sch_rdsDbInstance,
  iamRole: sch_iamRole,
  dynamoDbTable: sch_dynamoDbTable,
  ssmParameter: sch_ssmParameter,
  securityGroup: sch_securityGroup,
  vpc: sch_vpc,
  subnet: sch_subnet,
  sqsQueue: sch_sqsQueue,
  snsTopic: sch_snsTopic,
  ecsCluster: sch_ecsCluster,
  ecrRepository: sch_ecrRepository,
  elbv2LoadBalancer: sch_elbv2LoadBalancer,
  generic: sch_generic,
  empty: sch_empty,
} as const;

const pricingResponses = {
  s3Storage: prc_s3Storage,
  ec2T3Micro: prc_ec2T3Micro,
  ec2T3Small: prc_ec2T3Small,
  ec2M5Large: prc_ec2M5Large,
  rdsT3MicroPostgres: prc_rdsT3MicroPostgres,
  rdsT3MicroMysql: prc_rdsT3MicroMysql,
  rdsR6gLargeAuroraPostgres: prc_rdsR6gLargeAuroraPostgres,
  rdsR6gLargeAuroraMysql: prc_rdsR6gLargeAuroraMysql,
  rdsT3MicroMariadb: prc_rdsT3MicroMariadb,
  ssmParameter: prc_ssmParameter,
  ebsGp3Storage: prc_ebsGp3Storage,
  publicIpv4: prc_publicIpv4,
  dataTransferOut: prc_dataTransferOut,
  rdsT3MicroPostgresMultiAZ: prc_rdsT3MicroPostgresMultiAZ,
  rdsStorageGp3: prc_rdsStorageGp3,
  rdsBackupStorage: prc_rdsBackupStorage,
  s3PutRequests: prc_s3PutRequests,
  s3GetRequests: prc_s3GetRequests,
  s3DataTransfer: prc_s3DataTransfer,
  lambdaRequests: prc_lambdaRequests,
  lambdaDuration: prc_lambdaDuration,
  cloudWatchLogs: prc_cloudWatchLogs,
  sqsStandardRequests: prc_sqsStandardRequests,
  sqsFifoRequests: prc_sqsFifoRequests,
  snsPublishes: prc_snsPublishes,
  ecrStorage: prc_ecrStorage,
  elbv2AlbHourly: prc_elbv2AlbHourly,
  elbv2AlbLcu: prc_elbv2AlbLcu,
  emptyData: prc_emptyData,
  zeroPrice: prc_zeroPrice,
  emptyResponse: prc_emptyResponse,
  malformedJson: prc_malformedJson,
} as const;

const docSearchResponses = {
  s3BucketName: dsr_s3BucketName,
  ec2InstanceType: dsr_ec2InstanceType,
  lambdaRuntime: dsr_lambdaRuntime,
  rdsEngine: dsr_rdsEngine,
  unstructuredWithUrl: dsr_unstructuredWithUrl,
  emptyResults: dsr_emptyResults,
  noResultsText: dsr_noResultsText,
  nullResponse: dsr_nullResponse,
} as const;

const docReadSectionsResponses = {
  s3BucketName: drs_s3BucketName,
  ec2InstanceType: drs_ec2InstanceType,
  lambdaRuntime: drs_lambdaRuntime,
  rdsEngine: drs_rdsEngine,
  dynamoDbBillingMode: drs_dynamoDbBillingMode,
  longContent: drs_longContent,
  withNotFoundNote: drs_withNotFoundNote,
  noMatchingSections: drs_noMatchingSections,
  serverError: drs_serverError,
} as const;

const docReadFullResponses = {
  s3BucketFull: drf_s3BucketFull,
  lambdaFunctionFull: drf_lambdaFunctionFull,
  emptyPage: drf_emptyPage,
} as const;

const iamResponses = {
  s3BucketAllowed: iam_s3BucketAllowed,
  ec2InstancePartialDeny: iam_ec2InstancePartialDeny,
  lambdaFunctionAllowed: iam_lambdaFunctionAllowed,
  ssmParameterAllowed: iam_ssmParameterAllowed,
  securityGroupAllowed: iam_securityGroupAllowed,
  vpcAllowed: iam_vpcAllowed,
  dynamoDbTableAllowed: iam_dynamoDbTableAllowed,
  elbv2LoadBalancerAllowed: iam_elbv2LoadBalancerAllowed,
} as const;

const securityPostureResponses = {
  s3BucketPosture: sec_s3BucketPosture,
  noFindings: sec_noFindings,
  serviceDisabled: sec_serviceDisabled,
  checkServicesAllEnabled: sec_checkServicesAllEnabled,
  checkServicesDisabled: sec_checkServicesDisabled,
} as const;

const billingResponses = {
  s3BucketCost: bil_s3BucketCost,
  multiResourceCost: bil_multiResourceCost,
  noCostData: bil_noCostData,
  costForecast: bil_costForecast,
} as const;

export const McpMocks = {
  schema: schemaResponses,
  pricing: pricingResponses,
  docSearch: docSearchResponses,
  docReadSections: docReadSectionsResponses,
  docReadFull: docReadFullResponses,
  iam: iamResponses,
  security: securityPostureResponses,
  billing: billingResponses,
} as const;

export const RawSchemas = {
  s3Bucket: unwrapSchemaPayload(schemaResponses.s3Bucket.success),
  ec2Instance: unwrapSchemaPayload(schemaResponses.ec2Instance.success),
  lambdaFunction: unwrapSchemaPayload(schemaResponses.lambdaFunction.success),
  rdsDbInstance: unwrapSchemaPayload(schemaResponses.rdsDbInstance.success),
  iamRole: unwrapSchemaPayload(schemaResponses.iamRole.success),
  dynamoDbTable: unwrapSchemaPayload(schemaResponses.dynamoDbTable.success),
  ssmParameter: unwrapSchemaPayload(schemaResponses.ssmParameter.success),
  securityGroup: unwrapSchemaPayload(schemaResponses.securityGroup.success),
  vpc: unwrapSchemaPayload(schemaResponses.vpc.success),
  subnet: unwrapSchemaPayload(schemaResponses.subnet.success),
  sqsQueue: unwrapSchemaPayload(schemaResponses.sqsQueue.success),
  snsTopic: unwrapSchemaPayload(schemaResponses.snsTopic.success),
  ecsCluster: unwrapSchemaPayload(schemaResponses.ecsCluster.success),
  ecrRepository: unwrapSchemaPayload(schemaResponses.ecrRepository.success),
  elbv2LoadBalancer: unwrapSchemaPayload(
    schemaResponses.elbv2LoadBalancer.success,
  ),
} as const;

export const RawSchemasByType: Record<string, Record<string, unknown>> = {
  "AWS::S3::Bucket": RawSchemas.s3Bucket,
  "AWS::EC2::Instance": RawSchemas.ec2Instance,
  "AWS::Lambda::Function": RawSchemas.lambdaFunction,
  "AWS::RDS::DBInstance": RawSchemas.rdsDbInstance,
  "AWS::IAM::Role": RawSchemas.iamRole,
  "AWS::DynamoDB::Table": RawSchemas.dynamoDbTable,
  "AWS::SSM::Parameter": RawSchemas.ssmParameter,
  "AWS::EC2::SecurityGroup": RawSchemas.securityGroup,
  "AWS::EC2::VPC": RawSchemas.vpc,
  "AWS::EC2::Subnet": RawSchemas.subnet,
  "AWS::SQS::Queue": RawSchemas.sqsQueue,
  "AWS::SNS::Topic": RawSchemas.snsTopic,
  "AWS::ECS::Cluster": RawSchemas.ecsCluster,
  "AWS::ECR::Repository": RawSchemas.ecrRepository,
  "AWS::ElasticLoadBalancingV2::LoadBalancer": RawSchemas.elbv2LoadBalancer,
};
