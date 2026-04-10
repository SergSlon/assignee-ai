/**
 * Comprehensive MCP mock responses for MCP servers and tools, plus raw schema data.
 * ALL response data captured from live servers on 2026-03-22.
 *
 * Usage in tests:
 *   import { McpMocks, createMockTool } from "../test-fixtures/mcp-mock-responses.js";
 *   const tool = createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success);
 *
 * Schema data:
 *   Schema responses are available in MCP-wrapped format (McpMocks.schema.*.success)
 *   and as raw objects (RawSchemas.*) for mocking CloudFormationSchemaService.getSchema().
 *
 * MCP responses mirror the wire format:
 * - Pricing/Schema/IAM/Security: { type: "text", text: "<json>" }
 * - Documentation read_sections/read_documentation: { result: "<content>" }
 * - Documentation search_documentation: { search_results: [...], query_id, facets }
 * See: apps/cli/src/utils/mcp.ts — unwrapMcpText()
 *
 * aws-knowledge-mcp-server: configured but no app code calls its tools — no mocks needed.
 */

import { vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";

// ── Helper: wrap JSON in MCP content block ──────────────────────────────────

function mcpText(payload: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(payload) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CloudFormation Resource Schemas
//    Originally captured 2026-03-22; now fetched via CloudFormationSchemaService
//    (DescribeType SDK) — see Story 31.x.
// ═══════════════════════════════════════════════════════════════════════════════

const schemaResponses = {
  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::S3::Bucket" }. 30 props in full schema, trimmed to 10. */
  s3Bucket: {
    success: mcpText({
      typeName: "AWS::S3::Bucket",
      description:
        "The ``AWS::S3::Bucket`` resource creates an Amazon S3 bucket in the same AWS Region where you create the AWS CloudFormation stack.\n To control how AWS CloudFormation handles the bucket when the stack is deleted, you can set a deletion policy for your bucket. You can choose to *retain* the bucket or to *delete* the bucket. For more information, see [DeletionPolicy Attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html).\n  You can only delete empty buckets. Deletion fails for buckets that have contents.",
      properties: {
        Tags: {
          type: "array",
          description:
            "An arbitrary set of tags (key-value pairs) for this S3 bucket.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
        Arn: {
          description: "",
          $ref: "#/definitions/Arn",
        },
        BucketName: {
          type: "string",
          description:
            "A name for the bucket. If you don't specify a name, AWS CloudFormation generates a unique ID and uses that ID for the bucket name. The bucket name must contain only lowercase letters, numbers, periods (.), and dashes (-) and must follow [Amazon S3 bucket restrictions and limitations](https://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html). For more information, see [Rules for naming Amazon S3 buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html) in the *Amazon S3 User Guide*. \n  If you specify a name, you can't perform updates that require replacement of this resource. You can perform updates that require no or some interruption. If you need to replace the resource, specify a new name.",
        },
        VersioningConfiguration: {
          description:
            "Enables multiple versions of all objects in this bucket. You might enable versioning to prevent objects from being deleted or overwritten by mistake or to archive objects so that you can retrieve previous versions of them.\n  When you enable versioning on a bucket for the first time, it might take a short amount of time for the change to be fully propagated. We recommend that you wait for 15 minutes after enabling versioning before issuing write operations (``PUT`` or ``DELETE``) on objects in the bucket.",
          $ref: "#/definitions/VersioningConfiguration",
        },
        BucketEncryption: {
          description:
            "Specifies default encryption for a bucket using server-side encryption with Amazon S3-managed keys (SSE-S3), AWS KMS-managed keys (SSE-KMS), or dual-layer server-side encryption with KMS-managed keys (DSSE-KMS). For information about the Amazon S3 default encryption feature, see [Amazon S3 Default Encryption for S3 Buckets](https://docs.aws.amazon.com/AmazonS3/latest/dev/bucket-encryption.html) in the *Amazon S3 User Guide*.",
          $ref: "#/definitions/BucketEncryption",
        },
        AccessControl: {
          type: "string",
          description:
            "This is a legacy property, and it is not recommended for most use cases. A majority of modern use cases in Amazon S3 no longer require the use of ACLs, and we recommend that you keep ACLs disabled. For more information, see [Controlling object ownership](https://docs.aws.amazon.com//AmazonS3/latest/userguide/about-object-ownership.html) in the *Amazon S3 User Guide*.\n  A canned access control list (ACL) that grants predefined permissions to the bucket. For more information about canned ACLs, see [Canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl) in the *Amazon S3 User Guide*.\n  S3 buckets are created with ACLs disabled by default. Therefore, unless you explicitly set the [AWS::S3::OwnershipControls](https://docs.aws.amazon.com//AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-ownershipcontrols.html) property to enable ACLs, your resource will fail to deploy with any value other than Private. Use cases requiring ACLs are uncommon.\n  The majority of access control configurations can be successfully and more easily achieved with bucket policies. For more information, see [AWS::S3::BucketPolicy](https://docs.aws.amazon.com//AWSCloudFormation/latest/UserGuide/aws-properties-s3-policy.html). For examples of common policy configurations, including S3 Server Access Logs buckets and more, see [Bucket policy examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html) in the *Amazon S3 User Guide*.",
          enum: [
            "AuthenticatedRead",
            "AwsExecRead",
            "BucketOwnerFullControl",
            "BucketOwnerRead",
            "LogDeliveryWrite",
            "Private",
            "PublicRead",
            "PublicReadWrite",
          ],
        },
        PublicAccessBlockConfiguration: {
          description:
            "Configuration that defines how Amazon S3 handles public access.",
          $ref: "#/definitions/PublicAccessBlockConfiguration",
        },
        LifecycleConfiguration: {
          description:
            "Specifies the lifecycle configuration for objects in an Amazon S3 bucket. For more information, see [Object Lifecycle Management](https://docs.aws.amazon.com/AmazonS3/latest/dev/object-lifecycle-mgmt.html) in the *Amazon S3 User Guide*.",
          $ref: "#/definitions/LifecycleConfiguration",
        },
      },
      required: [],
      readOnlyProperties: [
        "/properties/Arn",
        "/properties/DomainName",
        "/properties/DualStackDomainName",
        "/properties/RegionalDomainName",
        "/properties/MetadataTableConfiguration/S3TablesDestination/TableNamespace",
        "/properties/MetadataTableConfiguration/S3TablesDestination/TableArn",
        "/properties/MetadataConfiguration/Destination",
        "/properties/MetadataConfiguration/JournalTableConfiguration/TableName",
        "/properties/MetadataConfiguration/JournalTableConfiguration/TableArn",
        "/properties/MetadataConfiguration/InventoryTableConfiguration/TableName",
        "/properties/MetadataConfiguration/InventoryTableConfiguration/TableArn",
        "/properties/WebsiteURL",
      ],
      primaryIdentifier: ["/properties/BucketName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::EC2::Instance" }. 48 props in full schema, trimmed to 10. */
  ec2Instance: {
    success: mcpText({
      typeName: "AWS::EC2::Instance",
      description: "Resource Type definition for AWS::EC2::Instance",
      properties: {
        Tags: {
          type: "array",
          description: "The tags to add to the instance.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
        InstanceType: {
          type: "string",
          description: "The instance type.",
        },
        ImageId: {
          type: "string",
          description:
            "The ID of the AMI. An AMI ID is required to launch an instance and must be specified here or in a launch template.",
        },
        KeyName: {
          type: "string",
          description: "The name of the key pair.",
        },
        SecurityGroupIds: {
          type: "array",
          description: "The IDs of the security groups.",
          insertionOrder: false,
          items: {
            type: "string",
          },
        },
        SubnetId: {
          type: "string",
          description:
            "[EC2-VPC] The ID of the subnet to launch the instance into.\n\n",
        },
        InstanceId: {
          type: "string",
          description: "The EC2 Instance ID.",
        },
        BlockDeviceMappings: {
          type: "array",
          description:
            "The block device mapping entries that defines the block devices to attach to the instance at launch.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/BlockDeviceMapping",
          },
        },
      },
      required: [],
      readOnlyProperties: [
        "/properties/InstanceId",
        "/properties/PrivateIp",
        "/properties/PublicDnsName",
        "/properties/PublicIp",
        "/properties/PrivateDnsName",
        "/properties/VpcId",
        "/properties/State",
      ],
      primaryIdentifier: ["/properties/InstanceId"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::Lambda::Function" }. 33 props in full schema, trimmed to 10. */
  lambdaFunction: {
    success: mcpText({
      typeName: "AWS::Lambda::Function",
      description:
        "The ``AWS::Lambda::Function`` resource creates a Lambda function. To create a function, you need a [deployment package](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html) and an [execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html). The deployment package is a .zip file archive or container image that contains your function code. The execution role grants the function permission to use AWS services, such as Amazon CloudWatch Logs for log streaming and AWS X-Ray for request tracing.\n You set the package type to ``Image`` if the deployment package is a [container image](https://docs.aws.amazon.com/lambda/latest/dg/lambda-images.html). For these functions, include the URI of the container image in the ECR registry in the [ImageUri property of the Code property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-imageuri). You do not need to specify the handler and runtime properties. \n You set the package type to ``Zip`` if the deployment package is a [.zip file archive](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html#gettingstarted-package-zip). For these functions, specify the S3 location of your .zip file in the ``Code`` property. Alternatively, for Node.js and Python functions, you can define your function inline in the [ZipFile property of the Code property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-zipfile). In both cases, you must also specify the handler and runtime properties.\n You can use [code signing](https://docs.aws.amazon.com/lambda/latest/dg/configuration-codesigning.html) if your deployment package is a .zip file archive. To enable code signing for this function, specify the ARN of a code-signing configuration. When a user attempts to deploy a code package with ``UpdateFunctionCode``, Lambda checks that the code package has a valid signature from a trusted publisher. The code-signing configuration includes a set of signing profiles, which define the trusted publishers for this function.\n When you update a ``AWS::Lambda::Function`` resource, CFNshort calls the [UpdateFunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionConfiguration.html) and [UpdateFunctionCode](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionCode.html)LAM APIs under the hood. Because these calls happen sequentially, and invocations can happen between these calls, your function may encounter errors in the time between the calls. For example, if you remove an environment variable, and the code that references that environment variable in the same CFNshort update, you may see invocation errors related to a missing environment variable. To work around this, you can invoke your function against a version or alias by default, rather than the ``$LATEST`` version.\n Note that you configure [provisioned concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html) on a ``AWS::Lambda::Version`` or a ``AWS::Lambda::Alias``.\n For a complete introduction to Lambda functions, see [What is Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/lambda-welcome.html) in the *Lambda developer guide.*",
      properties: {
        Tags: {
          type: "array",
          description:
            "A list of [tags](https://docs.aws.amazon.com/lambda/latest/dg/tagging.html) to apply to the function.\n  You must have the ``lambda:TagResource``, ``lambda:UntagResource``, and ``lambda:ListTags`` permissions for your [principal](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html) to manage the CFN stack. If you don't have these permissions, there might be unexpected behavior with stack-level tags propagating to the resource during resource creation and update.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
        Arn: {
          type: "string",
          description: "",
        },
        FunctionName: {
          type: "string",
          description:
            "The name of the Lambda function, up to 64 characters in length. If you don't specify a name, CFN generates one.\n If you specify a name, you cannot perform updates that require replacement of this resource. You can perform updates that require no or some interruption. If you must replace the resource, specify a new name.",
          minLength: 1,
        },
        Runtime: {
          type: "string",
          description:
            "The identifier of the function's [runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html). Runtime is required if the deployment package is a .zip file archive. Specifying a runtime results in an error if you're deploying a function using a container image.\n The following list includes deprecated runtimes. Lambda blocks creating new functions and updating existing functions shortly after each runtime is deprecated. For more information, see [Runtime use after deprecation](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html#runtime-deprecation-levels).\n For a list of all currently supported runtimes, see [Supported runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html#runtimes-supported).",
        },
        Role: {
          type: "string",
          description:
            "The Amazon Resource Name (ARN) of the function's execution role.",
          pattern:
            "^arn:(aws[a-zA-Z-]*)?:iam::\\d{12}:role/?[a-zA-Z_0-9+=,.@\\-_/]+$",
        },
        Handler: {
          type: "string",
          description:
            "The name of the method within your code that Lambda calls to run your function. Handler is required if the deployment package is a .zip file archive. The format includes the file name. It can also include namespaces and other qualifiers, depending on the runtime. For more information, see [Lambda programming model](https://docs.aws.amazon.com/lambda/latest/dg/foundation-progmodel.html).",
          pattern: "^[^\\s]+$",
          maxLength: 128,
        },
        Code: {
          description:
            "The code for the function. You can define your function code in multiple ways:\n  +  For .zip deployment packages, you can specify the S3 location of the .zip file in the ``S3Bucket``, ``S3Key``, and ``S3ObjectVersion`` properties.\n  +  For .zip deployment packages, you can alternatively define the function code inline in the ``ZipFile`` property. This method works only for Node.js and Python functions.\n  +  For container images, specify the URI of your container image in the ECR registry in the ``ImageUri`` property.",
          $ref: "#/definitions/Code",
        },
        MemorySize: {
          type: "integer",
          description:
            "The amount of [memory available to the function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-common.html#configuration-memory-console) at runtime. Increasing the function memory also increases its CPU allocation. The default value is 128 MB. The value can be any multiple of 1 MB. Note that new AWS accounts have reduced concurrency and memory quotas. AWS raises these quotas automatically based on your usage. You can also request a quota increase.",
        },
        Timeout: {
          type: "integer",
          description:
            "The amount of time (in seconds) that Lambda allows a function to run before stopping it. The default is 3 seconds. The maximum allowed value is 900 seconds. For more information, see [Lambda execution environment](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-context.html).",
          minimum: 1,
        },
        Environment: {
          description:
            "Environment variables that are accessible from function code during execution.",
          $ref: "#/definitions/Environment",
        },
      },
      required: ["Code", "Role"],
      readOnlyProperties: [
        "/properties/SnapStartResponse",
        "/properties/SnapStartResponse/ApplyOn",
        "/properties/SnapStartResponse/OptimizationStatus",
        "/properties/Arn",
      ],
      primaryIdentifier: ["/properties/FunctionName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::RDS::DBInstance" }. 99 props in full schema, trimmed to 12. */
  rdsDbInstance: {
    success: mcpText({
      typeName: "AWS::RDS::DBInstance",
      description:
        "The ``AWS::RDS::DBInstance`` resource creates an Amazon DB instance. The new DB instance can be an RDS DB instance, or it can be a DB instance in an Aurora DB cluster.\n For more information about creating an RDS DB instance, see [Creating an Amazon RDS DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html) in the *Amazon RDS User Guide*.\n For more information about creating a DB instance in an Aurora DB cluster, see [Creating an Amazon Aurora DB cluster](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.CreateInstance.html) in the *Amazon Aurora User Guide*.\n If you import an existing DB instance, and the template configuration doesn't match the actual configuration of the DB instance, AWS CloudFormation applies the changes in the template during the import operation.\n  If a DB instance is deleted or replaced during an update, AWS CloudFormation deletes all automated snapshots. However, it retains manual DB snapshots. During an update that requires replacement, you can apply a stack policy to prevent DB instances from being replaced. For more information, see [Prevent Updates to Stack Resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/protect-stack-resources.html).\n   *Updating DB instances* \n When properties labeled \"*Update requires:*[Replacement](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html#update-replacement)\" are updated, AWS CloudFormation first creates a replacement DB instance, then changes references from other dependent resources to point to the replacement DB instance, and finally deletes the old DB instance.\n  We highly recommend that you take a snapshot of the database before updating the stack. If you don't, you lose the data when AWS CloudFormation replaces your DB instance. To preserve your data, perform the following procedure:\n  1.  Deactivate any applications that are using the DB instance so that there's no activity on the DB instance.\n  1.  Create a snapshot of the DB instance. For more information, see [Creating a DB Snapshot](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateSnapshot.html).\n  1.  If you want to restore your instance using a DB snapshot, modify the updated template with your DB instance changes and add the ``DBSnapshotIdentifier`` property with the ID of the DB snapshot that you want to use.\n After you restore a DB instance with a ``DBSnapshotIdentifier`` property, you can delete the ``DBSnapshotIdentifier`` property. When you specify this property for an update, the DB instance is not restored from the DB snapshot again, and the data in the database is not changed. However, if you don't specify the ``DBSnapshotIdentifier`` property, an empty DB instance is created, and the original DB instance is deleted. If you specify a property that is different from the previous snapshot restore property, a new DB instance is restored from the specified ``DBSnapshotIdentifier`` property, and the original DB instance is deleted.\n  1.  Update the stack.\n  \n  For more information about updating other properties of this resource, see ``ModifyDBInstance``. For more information about updating stacks, see [CloudFormation Stacks Updates](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks.html).\n  *Deleting DB instances* \n For DB instances that are part of an Aurora DB cluster, you can set a deletion policy for your DB instance to control how AWS CloudFormation handles the DB instance when the stack is deleted. For Amazon RDS DB instances, you can choose to *retain* the DB instance, to *delete* the DB instance, or to *create a snapshot* of the DB instance. The default AWS CloudFormation behavior depends on the ``DBClusterIdentifier`` property:\n  1.  For ``AWS::RDS::DBInstance`` resources that don't specify the ``DBClusterIdentifier`` property, AWS CloudFormation saves a snapshot of the DB instance.\n  1.   For ``AWS::RDS::DBInstance`` resources that do specify the ``DBClusterIdentifier`` property, AWS CloudFormation deletes the DB instance.\n  \n  For more information, see [DeletionPolicy Attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html).",
      properties: {
        Tags: {
          type: "array",
          description: "Tags to assign to the DB instance.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
        DBInstanceIdentifier: {
          type: "string",
          description:
            "A name for the DB instance. If you specify a name, AWS CloudFormation converts it to lowercase. If you don't specify a name, AWS CloudFormation generates a unique physical ID and uses that ID for the DB instance. For more information, see [Name Type](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-name.html).\n For information about constraints that apply to DB instance identifiers, see [Naming constraints in Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.Constraints) in the *Amazon RDS User Guide*.\n  If you specify a name, you can't perform updates that require replacement of this resource. You can perform updates that require no or some interruption. If you must replace the resource, specify a new name.",
          pattern: "^$|^[a-zA-Z]{1}(?:-?[a-zA-Z0-9]){0,62}$",
          minLength: 1,
          maxLength: 63,
        },
        DBInstanceClass: {
          type: "string",
          description:
            "The compute and memory capacity of the DB instance, for example ``db.m5.large``. Not all DB instance classes are available in all AWS-Regions, or for all database engines. For the full list of DB instance classes, and availability for your engine, see [DB instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html) in the *Amazon RDS User Guide* or [Aurora DB instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.DBInstanceClass.html) in the *Amazon Aurora User Guide*.",
        },
        Engine: {
          type: "string",
          description:
            "The name of the database engine to use for this DB instance. Not every database engine is available in every AWS Region.\n This property is required when creating a DB instance.\n  You can convert an Oracle database from the non-CDB architecture to the container database (CDB) architecture by updating the ``Engine`` value in your templates from ``oracle-ee`` to ``oracle-ee-cdb`` or from ``oracle-se2`` to ``oracle-se2-cdb``. Converting to the CDB architecture requires an interruption.\n  Valid Values:\n  +  ``aurora-mysql`` (for Aurora MySQL DB instances)\n  +  ``aurora-postgresql`` (for Aurora PostgreSQL DB instances)\n  +  ``custom-oracle-ee`` (for RDS Custom for Oracle DB instances)\n  +  ``custom-oracle-ee-cdb`` (for RDS Custom for Oracle DB instances)\n  +  ``custom-sqlserver-ee`` (for RDS Custom for SQL Server DB instances)\n  +  ``custom-sqlserver-se`` (for RDS Custom for SQL Server DB instances)\n  +  ``custom-sqlserver-web`` (for RDS Custom for SQL Server DB instances)\n  +   ``db2-ae`` \n  +   ``db2-se`` \n  +   ``mariadb`` \n  +   ``mysql`` \n  +   ``oracle-ee`` \n  +   ``oracle-ee-cdb`` \n  +   ``oracle-se2`` \n  +   ``oracle-se2-cdb`` \n  +   ``postgres`` \n  +   ``sqlserver-ee`` \n  +   ``sqlserver-se`` \n  +   ``sqlserver-ex`` \n  +   ``sqlserver-web``",
        },
        MasterUsername: {
          type: "string",
          description:
            "The master user name for the DB instance.\n  If you specify the ``SourceDBInstanceIdentifier`` or ``DBSnapshotIdentifier`` property, don't specify this property. The value is inherited from the source DB instance or snapshot.\n When migrating a self-managed Db2 database, we recommend that you use the same master username as your self-managed Db2 instance name.\n   *Amazon Aurora* \n Not applicable. The name for the master user is managed by the DB cluster. \n  *RDS for Db2* \n Constraints:\n  +  Must be 1 to 16 letters or numbers.\n  +  First character must be a letter.\n  +  Can't be a reserved word for the chosen database engine.\n  \n  *RDS for MariaDB* \n Constraints:\n  +  Must be 1 to 16 letters or numbers.\n  +  Can't be a reserved word for the chosen database engine.\n  \n  *RDS for Microsoft SQL Server* \n Constraints:\n  +  Must be 1 to 128 letters or numbers.\n  +  First character must be a letter.\n  +  Can't be a reserved word for the chosen database engine.\n  \n  *RDS for MySQL* \n Constraints:\n  +  Must be 1 to 16 letters or numbers.\n  +  First character must be a letter.\n  +  Can't be a reserved word for the chosen database engine.\n  \n  *RDS for Oracle* \n Constraints:\n  +  Must be 1 to 30 letters or numbers.\n  +  First character must be a letter.\n  +  Can't be a reserved word for the chosen database engine.\n  \n  *RDS for PostgreSQL* \n Constraints:\n  +  Must be 1 to 63 letters or numbers.\n  +  First character must be a letter.\n  +  Can't be a reserved word for the chosen database engine.",
          pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,127}$",
          minLength: 1,
          maxLength: 128,
        },
        MasterUserPassword: {
          type: "string",
          description:
            'The password for the master user. The password can include any printable ASCII character except "/", """, or "@".\n  *Amazon Aurora* \n Not applicable. The password for the master user is managed by the DB cluster.\n  *RDS for Db2* \n Must contain from 8 to 255 characters.\n  *RDS for MariaDB* \n Constraints: Must contain from 8 to 41 characters.\n  *RDS for Microsoft SQL Server* \n Constraints: Must contain from 8 to 128 characters.\n  *RDS for MySQL* \n Constraints: Must contain from 8 to 41 characters.\n  *RDS for Oracle* \n Constraints: Must contain from 8 to 30 characters.\n  *RDS for PostgreSQL* \n Constraints: Must contain from 8 to 128 characters.',
        },
        AllocatedStorage: {
          type: "string",
          description:
            "The amount of storage in gibibytes (GiB) to be initially allocated for the database instance.\n  If any value is set in the ``Iops`` parameter, ``AllocatedStorage`` must be at least 100 GiB, which corresponds to the minimum Iops value of 1,000. If you increase the ``Iops`` value (in 1,000 IOPS increments), then you must also increase the ``AllocatedStorage`` value (in 100-GiB increments). \n   *Amazon Aurora* \n Not applicable. Aurora cluster volumes automatically grow as the amount of data in your database increases, though you are only charged for the space that you use in an Aurora cluster volume.\n  *Db2* \n Constraints to the amount of storage for each storage type are the following:\n  +  General Purpose (SSD) storage (gp3): Must be an integer from 20 to 64000.\n  +  Provisioned IOPS storage (io1): Must be an integer from 100 to 64000.\n  \n  *MySQL* \n Constraints to the amount of storage for each storage type are the following: \n  +  General Purpose (SSD) storage (gp2): Must be an integer from 20 to 65536.\n  +  Provisioned IOPS storage (io1): Must be an integer from 100 to 65536.\n  +  Magnetic storage (standard): Must be an integer from 5 to 3072.\n  \n  *MariaDB* \n Constraints to the amount of storage for each storage type are the following: \n  +  General Purpose (SSD) storage (gp2): Must be an integer from 20 to 65536.\n  +  Provisioned IOPS storage (io1): Must be an integer from 100 to 65536.\n  +  Magnetic storage (standard): Must be an integer from 5 to 3072.\n  \n  *PostgreSQL* \n Constraints to the amount of storage for each storage type are the following: \n  +  General Purpose (SSD) storage (gp2): Must be an integer from 20 to 65536.\n  +  Provisioned IOPS storage (io1): Must be an integer from 100 to 65536.\n  +  Magnetic storage (standard): Must be an integer from 5 to 3072.\n  \n  *Oracle* \n Constraints to the amount of storage for each storage type are the following: \n  +  General Purpose (SSD) storage (gp2): Must be an integer from 20 to 65536.\n  +  Provisioned IOPS storage (io1): Must be an integer from 100 to 65536.\n  +  Magnetic storage (standard): Must be an integer from 10 to 3072.\n  \n  *SQL Server* \n Constraints to the amount of storage for each storage type are the following: \n  +  General Purpose (SSD) storage (gp2):\n  +  Enterprise and Standard editions: Must be an integer from 20 to 16384.\n  +  Web and Express editions: Must be an integer from 20 to 16384.\n  \n  +  Provisioned IOPS storage (io1):\n  +  Enterprise and Standard editions: Must be an integer from 20 to 16384.\n  +  Web and Express editions: Must be an integer from 20 to 16384.\n  \n  +  Magnetic storage (standard):\n  +  Enterprise and Standard editions: Must be an integer from 20 to 1024.\n  +  Web and Express editions: Must be an integer from 20 to 1024.",
          pattern: "^[0-9]*$",
        },
        StorageType: {
          type: "string",
          description:
            "The storage type to associate with the DB instance.\n If you specify ``io1``, ``io2``, or ``gp3``, you must also include a value for the ``Iops`` parameter.\n This setting doesn't apply to Amazon Aurora DB instances. Storage is managed by the DB cluster.\n Valid Values: ``gp2 | gp3 | io1 | io2 | standard``\n Default: ``io1``, if the ``Iops`` parameter is specified. Otherwise, ``gp3``.",
        },
        MultiAZ: {
          type: "boolean",
          description:
            "Specifies whether the DB instance is a Multi-AZ deployment. You can't set the ``AvailabilityZone`` parameter if the DB instance is a Multi-AZ deployment.\n This setting doesn't apply to Amazon Aurora because the DB instance Availability Zones (AZs) are managed by the DB cluster.",
        },
        EngineVersion: {
          type: "string",
          description:
            "The version number of the database engine to use.\n For a list of valid engine versions, use the ``DescribeDBEngineVersions`` action.\n The following are the database engines and links to information about the major and minor versions that are available with Amazon RDS. Not every database engine is available for every AWS Region.\n  *Amazon Aurora* \n Not applicable. The version number of the database engine to be used by the DB instance is managed by the DB cluster.\n  *Db2* \n See [Amazon RDS for Db2](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Db2.html#Db2.Concepts.VersionMgmt) in the *Amazon RDS User Guide.*\n  *MariaDB* \n See [MariaDB on Amazon RDS Versions](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_MariaDB.html#MariaDB.Concepts.VersionMgmt) in the *Amazon RDS User Guide.*\n  *Microsoft SQL Server* \n See [Microsoft SQL Server Versions on Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_SQLServer.html#SQLServer.Concepts.General.VersionSupport) in the *Amazon RDS User Guide.*\n  *MySQL* \n See [MySQL on Amazon RDS Versions](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_MySQL.html#MySQL.Concepts.VersionMgmt) in the *Amazon RDS User Guide.*\n  *Oracle* \n See [Oracle Database Engine Release Notes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.Oracle.PatchComposition.html) in the *Amazon RDS User Guide.*\n  *PostgreSQL* \n See [Supported PostgreSQL Database Versions](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html#PostgreSQL.Concepts.General.DBVersions) in the *Amazon RDS User Guide.*",
        },
        DBName: {
          type: "string",
          description:
            "The meaning of this parameter differs according to the database engine you use.\n  If you specify the ``DBSnapshotIdentifier`` property, this property only applies to RDS for Oracle.\n   *Amazon Aurora* \n Not applicable. The database name is managed by the DB cluster.\n  *Db2* \n The name of the database to create when the DB instance is created. If this parameter isn't specified, no database is created in the DB instance.\n Constraints:\n  +  Must contain 1 to 64 letters or numbers.\n  +  Must begin with a letter. Subsequent characters can be letters, underscores, or digits (0-9).\n  +  Can't be a word reserved by the specified database engine.\n  \n  *MySQL* \n The name of the database to create when the DB instance is created. If this parameter is not specified, no database is created in the DB instance.\n Constraints:\n  +  Must contain 1 to 64 letters or numbers.\n  +  Can't be a word reserved by the specified database engine\n  \n  *MariaDB* \n The name of the database to create when the DB instance is created. If this parameter is not specified, no database is created in the DB instance.\n Constraints:\n  +  Must contain 1 to 64 letters or numbers.\n  +  Can't be a word reserved by the specified database engine\n  \n  *PostgreSQL* \n The name of the database to create when the DB instance is created. If this parameter is not specified, the default ``postgres`` database is created in the DB instance.\n Constraints:\n  +  Must begin with a letter. Subsequent characters can be letters, underscores, or digits (0-9).\n  +  Must contain 1 to 63 characters.\n  +  Can't be a word reserved by the specified database engine\n  \n  *Oracle* \n The Oracle System ID (SID) of the created DB instance. If you specify ``null``, the default value ``ORCL`` is used. You can't specify the string NULL, or any other reserved word, for ``DBName``. \n Default: ``ORCL``\n Constraints:\n  +  Can't be longer than 8 characters\n  \n  *SQL Server* \n Not applicable. Must be null.",
        },
        Port: {
          type: "string",
          description:
            "The port number on which the database accepts connections.\n This setting doesn't apply to Aurora DB instances. The port number is managed by the cluster.\n Valid Values: ``1150-65535``\n Default:\n  +  RDS for Db2 - ``50000``\n  +  RDS for MariaDB - ``3306``\n  +  RDS for Microsoft SQL Server - ``1433``\n  +  RDS for MySQL - ``3306``\n  +  RDS for Oracle - ``1521``\n  +  RDS for PostgreSQL - ``5432``\n  \n Constraints:\n  +  For RDS for Microsoft SQL Server, the value can't be ``1234``, ``1434``, ``3260``, ``3343``, ``3389``, ``47001``, or ``49152-49156``.",
          pattern: "^\\d*$",
        },
        PubliclyAccessible: {
          type: "boolean",
          description:
            "Indicates whether the DB instance is publicly accessible.",
        },
        StorageEncrypted: {
          type: "boolean",
          description:
            "A value that indicates whether the DB instance is encrypted.",
        },
        DeletionProtection: {
          type: "boolean",
          description:
            "A value that indicates whether the DB instance has deletion protection enabled.",
        },
        BackupRetentionPeriod: {
          type: "integer",
          description:
            "The number of days for which automated backups are retained.",
        },
      },
      required: [],
      readOnlyProperties: [
        "/properties/AutomaticRestartTime",
        "/properties/CertificateDetails",
        "/properties/CertificateDetails/CAIdentifier",
        "/properties/CertificateDetails/ValidTill",
        "/properties/Endpoint",
        "/properties/Endpoint/Address",
        "/properties/Endpoint/Port",
        "/properties/Endpoint/HostedZoneId",
        "/properties/DbiResourceId",
        "/properties/DBInstanceArn",
        "/properties/DBInstanceStatus",
        "/properties/InstanceCreateTime",
        "/properties/IsStorageConfigUpgradeAvailable",
        "/properties/LatestRestorableTime",
        "/properties/ListenerEndpoint",
        "/properties/ListenerEndpoint/Address",
        "/properties/ListenerEndpoint/Port",
        "/properties/ListenerEndpoint/HostedZoneId",
        "/properties/MasterUserSecret/SecretArn",
        "/properties/PercentProgress",
        "/properties/ReadReplicaDBClusterIdentifiers",
        "/properties/ReadReplicaDBInstanceIdentifiers",
        "/properties/ResumeFullAutomationModeTime",
        "/properties/SecondaryAvailabilityZone",
        "/properties/StatusInfos",
      ],
      primaryIdentifier: ["/properties/DBInstanceIdentifier"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::IAM::Role" }. 11 props (all kept). */
  iamRole: {
    success: mcpText({
      typeName: "AWS::IAM::Role",
      description:
        "Creates a new role for your AWS-account.\n  For more information about roles, see [IAM roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) in the *IAM User Guide*. For information about quotas for role names and the number of roles you can create, see [IAM and quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html) in the *IAM User Guide*.",
      properties: {
        Arn: {
          type: "string",
          description: "",
        },
        AssumeRolePolicyDocument: {
          type: ["object", "string"],
          description:
            "The trust policy that is associated with this role. Trust policies define which entities can assume the role. You can associate only one trust policy with a role. For an example of a policy that can be used to assume a role, see [Template Examples](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html#aws-resource-iam-role--examples). For more information about the elements that you can use in an IAM policy, see [Policy Elements Reference](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html) in the *User Guide*.",
        },
        Description: {
          type: "string",
          description: "A description of the role that you provide.",
        },
        ManagedPolicyArns: {
          type: "array",
          description:
            "A list of Amazon Resource Names (ARNs) of the IAM managed policies that you want to attach to the role.\n For more information about ARNs, see [Amazon Resource Names (ARNs) and Service Namespaces](https://docs.aws.amazon.com/general/latest/gr/aws-arns-and-namespaces.html) in the *General Reference*.",
          insertionOrder: false,
          items: {
            type: "string",
          },
        },
        MaxSessionDuration: {
          type: "integer",
          description:
            "The maximum session duration (in seconds) that you want to set for the specified role. If you do not specify a value for this setting, the default value of one hour is applied. This setting can have a value from 1 hour to 12 hours.\n Anyone who assumes the role from the CLI or API can use the ``DurationSeconds`` API parameter or the ``duration-seconds``CLI parameter to request a longer session. The ``MaxSessionDuration`` setting determines the maximum duration that can be requested using the ``DurationSeconds`` parameter. If users don't specify a value for the ``DurationSeconds`` parameter, their security credentials are valid for one hour by default. This applies when you use the ``AssumeRole*`` API operations or the ``assume-role*``CLI operations but does not apply when you use those operations to create a console URL. For more information, see [Using IAM roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use.html) in the *IAM User Guide*.",
        },
        Path: {
          type: "string",
          description:
            "The path to the role. For more information about paths, see [IAM Identifiers](https://docs.aws.amazon.com/IAM/latest/UserGuide/Using_Identifiers.html) in the *IAM User Guide*.\n This parameter is optional. If it is not included, it defaults to a slash (/).\n This parameter allows (through its [regex pattern](https://docs.aws.amazon.com/http://wikipedia.org/wiki/regex)) a string of characters consisting of either a forward slash (/) by itself or a string that must begin and end with forward slashes. In addition, it can contain any ASCII character from the ! (``\\u0021``) through the DEL character (``\\u007F``), including most punctuation characters, digits, and upper and lowercased letters.",
          default: "/",
        },
        PermissionsBoundary: {
          type: "string",
          description:
            "The ARN of the policy used to set the permissions boundary for the role.\n For more information about permissions boundaries, see [Permissions boundaries for IAM identities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) in the *IAM User Guide*.",
        },
        Policies: {
          type: "array",
          description:
            "Adds or updates an inline policy document that is embedded in the specified IAM role.\n When you embed an inline policy in a role, the inline policy is used as part of the role's access (permissions) policy. The role's trust policy is created at the same time as the role. You can update a role's trust policy later. For more information about IAM roles, go to [Using Roles to Delegate Permissions and Federate Identities](https://docs.aws.amazon.com/IAM/latest/UserGuide/roles-toplevel.html).\n A role can also have an attached managed policy. For information about policies, see [Managed Policies and Inline Policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/policies-managed-vs-inline.html) in the *User Guide*.\n For information about limits on the number of inline policies that you can embed with a role, see [Limitations on Entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/LimitationsOnEntities.html) in the *User Guide*.\n  If an external policy (such as ``AWS::IAM::Policy`` or ``AWS::IAM::ManagedPolicy``) has a ``Ref`` to a role and if a resource (such as ``AWS::ECS::Service``) also has a ``Ref`` to the same role, add a ``DependsOn`` attribute to the resource to make the resource depend on the external policy. This dependency ensures that the role's policy is available throughout the resource's lifecycle. For example, when you delete a stack with an ``AWS::ECS::Service`` resource, the ``DependsOn`` attribute ensures that CFN deletes the ``AWS::ECS::Service`` resource before deleting its role's policy.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Policy",
          },
        },
        RoleId: {
          type: "string",
          description: "",
        },
        RoleName: {
          type: "string",
          description:
            'A name for the IAM role, up to 64 characters in length. For valid values, see the ``RoleName`` parameter for the [CreateRole](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateRole.html) action in the *User Guide*.\n This parameter allows (per its [regex pattern](https://docs.aws.amazon.com/http://wikipedia.org/wiki/regex)) a string of characters consisting of upper and lowercase alphanumeric characters with no spaces. You can also include any of the following characters: _+=,.@-. The role name must be unique within the account. Role names are not distinguished by case. For example, you cannot create roles named both "Role1" and "role1".\n If you don\'t specify a name, CFN generates a unique physical ID and uses that ID for the role name.\n If you specify a name, you must specify the ``CAPABILITY_NAMED_IAM`` value to acknowledge your template\'s capabilities. For more information, see [Acknowledging Resources in Templates](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-template.html#using-iam-capabilities).\n  Naming an IAM resource can cause an unrecoverable error if you reuse the same template in multiple Regions. To prevent this, we recommend using ``Fn::Join`` and ``AWS::Region`` to create a Region-specific name, as in the following example: ``{"Fn::Join": ["", [{"Ref": "AWS::Region"}, {"Ref": "MyResourceName"}]]}``.',
        },
        Tags: {
          type: "array",
          description:
            "A list of tags that are attached to the role. For more information about tagging, see [Tagging IAM resources](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_tags.html) in the *IAM User Guide*.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: ["AssumeRolePolicyDocument"],
      readOnlyProperties: ["/properties/Arn", "/properties/RoleId"],
      primaryIdentifier: ["/properties/RoleName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::DynamoDB::Table" }. 22 props in full schema, trimmed to 10. */
  dynamoDbTable: {
    success: mcpText({
      typeName: "AWS::DynamoDB::Table",
      description:
        "The ``AWS::DynamoDB::Table`` resource creates a DDB table. For more information, see [CreateTable](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_CreateTable.html) in the *API Reference*.\n You should be aware of the following behaviors when working with DDB tables:\n  +  CFNlong typically creates DDB tables in parallel. However, if your template includes multiple DDB tables with indexes, you must declare dependencies so that the tables are created sequentially. DDBlong limits the number of tables with secondary indexes that are in the creating state. If you create multiple tables with indexes at the same time, DDB returns an error and the stack operation fails. For an example, see [DynamoDB Table with a DependsOn Attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table--examples--DynamoDB_Table_with_a_DependsOn_Attribute).\n  \n   Our guidance is to use the latest schema documented for your CFNlong templates. This schema supports the provisioning of all table settings below. When using this schema in your CFNlong templates, please ensure that your Identity and Access Management (IAM) policies are updated with appropriate permissions to allow for the authorization of these setting changes.",
      properties: {
        Tags: {
          type: "array",
          description:
            "An array of key-value pairs to apply to this resource.\n For more information, see [Tag](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-resource-tags.html).",
          items: {
            $ref: "#/definitions/Tag",
          },
        },
        Arn: {
          type: "string",
          description: "",
        },
        TableName: {
          type: "string",
          description:
            "A name for the table. If you don't specify a name, CFNlong generates a unique physical ID and uses that ID for the table name. For more information, see [Name Type](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-name.html).\n  If you specify a name, you cannot perform updates that require replacement of this resource. You can perform updates that require no or some interruption. If you must replace the resource, specify a new name.",
        },
        KeySchema: {
          description:
            "Specifies the attributes that make up the primary key for the table. The attributes in the ``KeySchema`` property must also be defined in the ``AttributeDefinitions`` property.",
        },
        AttributeDefinitions: {
          type: "array",
          description:
            "A list of attributes that describe the key schema for the table and indexes.\n This property is required to create a DDB table.\n Update requires: [Some interruptions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html#update-some-interrupt). Replacement if you edit an existing AttributeDefinition.",
          items: {
            $ref: "#/definitions/AttributeDefinition",
          },
        },
        BillingMode: {
          type: "string",
          description:
            "Specify how you are charged for read and write throughput and how you manage capacity.\n Valid values include:\n  +  ``PAY_PER_REQUEST`` - We recommend using ``PAY_PER_REQUEST`` for most DynamoDB workloads. ``PAY_PER_REQUEST`` sets the billing mode to [On-demand capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html). \n  +  ``PROVISIONED`` - We recommend using ``PROVISIONED`` for steady workloads with predictable growth where capacity requirements can be reliably forecasted. ``PROVISIONED`` sets the billing mode to [Provisioned capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/provisioned-capacity-mode.html).\n  \n If not specified, the default is ``PROVISIONED``.",
        },
        ProvisionedThroughput: {
          description:
            "Throughput for the specified table, which consists of values for ``ReadCapacityUnits`` and ``WriteCapacityUnits``. For more information about the contents of a provisioned throughput structure, see [Amazon DynamoDB Table ProvisionedThroughput](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_ProvisionedThroughput.html). \n If you set ``BillingMode`` as ``PROVISIONED``, you must specify this property. If you set ``BillingMode`` as ``PAY_PER_REQUEST``, you cannot specify this property.",
          $ref: "#/definitions/ProvisionedThroughput",
        },
        GlobalSecondaryIndexes: {
          type: "array",
          description:
            "Global secondary indexes to be created on the table. You can create up to 20 global secondary indexes.\n  If you update a table to include a new global secondary index, CFNlong initiates the index creation and then proceeds with the stack update. CFNlong doesn't wait for the index to complete creation because the backfilling phase can take a long time, depending on the size of the table. You can't use the index or update the table until the index's status is ``ACTIVE``. You can track its status by using the DynamoDB [DescribeTable](https://docs.aws.amazon.com/cli/latest/reference/dynamodb/describe-table.html) command.\n If you add or delete an index during an update, we recommend that you don't update any other resources. If your stack fails to update and is rolled back while adding a new index, you must manually delete the index. \n Updates are not supported. The following are exceptions:\n  +  If you update either the contributor insights specification or the provisioned throughput values of global secondary indexes, you can update the table without interruption.\n  +  You can delete or add one global secondary index without interruption. If you do both in the same update (for example, by changing the index's logical ID), the update fails.",
          items: {
            $ref: "#/definitions/GlobalSecondaryIndex",
          },
        },
      },
      required: ["KeySchema"],
      readOnlyProperties: ["/properties/Arn", "/properties/StreamArn"],
      primaryIdentifier: ["/properties/TableName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::SSM::Parameter" }. 9 props (all kept). */
  ssmParameter: {
    success: mcpText({
      typeName: "AWS::SSM::Parameter",
      description:
        "The ``AWS::SSM::Parameter`` resource creates an SSM parameter in SYSlong Parameter Store.\n  To create an SSM parameter, you must have the IAMlong (IAM) permissions ``ssm:PutParameter`` and ``ssm:AddTagsToResource``. On stack creation, CFNlong adds the following three tags to the parameter: ``aws:cloudformation:stack-name``, ``aws:cloudformation:logical-id``, and ``aws:cloudformation:stack-id``, in addition to any custom tags you specify.\n To add, update, or remove tags during stack update, you must have IAM permissions for both ``ssm:AddTagsToResource`` and ``ssm:RemoveTagsFromResource``. For more information, see [Managing access using policies](https://docs.aws.amazon.com/systems-manager/latest/userguide/security-iam.html#security_iam_access-manage) in the *User Guide*.\n  For information about valid values for parameters, see [About requirements and constraints for parameter names](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-su-create.html#sysman-parameter-name-constraints) in the *User Guide* and [PutParameter](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_PutParameter.html) in the *API Reference*.",
      properties: {
        Type: {
          type: "string",
          description:
            "The type of parameter.\n  Parameters of type ``SecureString`` are not supported by CFNlong.",
          enum: ["String", "StringList"],
        },
        Value: {
          type: "string",
          description:
            "The parameter value.\n  If type is ``StringList``, the system returns a comma-separated string with no spaces between commas in the ``Value`` field.",
        },
        Description: {
          type: "string",
          description: "Information about the parameter.",
        },
        Policies: {
          type: "string",
          description:
            "Information about the policies assigned to a parameter.\n [Assigning parameter policies](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-policies.html) in the *User Guide*.",
        },
        AllowedPattern: {
          type: "string",
          description:
            "A regular expression used to validate the parameter value. For example, for ``String`` types with values restricted to numbers, you can specify the following: ``AllowedPattern=^\\d+$``",
        },
        Tier: {
          type: "string",
          description: "The parameter tier.",
          enum: ["Standard", "Advanced", "Intelligent-Tiering"],
        },
        Tags: {
          type: "object",
          description:
            "Optional metadata that you assign to a resource in the form of an arbitrary set of tags (key-value pairs). Tags enable you to categorize a resource in different ways, such as by purpose, owner, or environment. For example, you might want to tag a SYS parameter to identify the type of resource to which it applies, the environment, or the type of configuration data referenced by the parameter.",
        },
        DataType: {
          type: "string",
          description:
            "The data type of the parameter, such as ``text`` or ``aws:ec2:image``. The default is ``text``.",
          enum: ["text", "aws:ec2:image"],
        },
        Name: {
          type: "string",
          description:
            "The name of the parameter.\n  The reported maximum length of 2048 characters for a parameter name includes 1037 characters that are reserved for internal use by SYS. The maximum length for a parameter name that you specify is 1011 characters.\n This count of 1011 characters includes the characters in the ARN that precede the name you specify. This ARN length will vary depending on your partition and Region. For example, the following 45 characters count toward the 1011 character maximum for a parameter created in the US East (Ohio) Region: ``arn:aws:ssm:us-east-2:111122223333:parameter/``.",
        },
      },
      required: ["Value", "Type"],
      primaryIdentifier: ["/properties/Name"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::EC2::SecurityGroup" }. 13 props in full schema, trimmed to 6. */
  securityGroup: {
    success: mcpText({
      typeName: "AWS::EC2::SecurityGroup",
      description:
        "Specifies a security group. To create a security group, use the [VpcId](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ec2-security-group.html#cfn-ec2-securitygroup-vpcid) property to specify the VPC for which to create the security group.",
      properties: {
        GroupDescription: {
          type: "string",
          description:
            "A description for the security group. This is informational only.\n Constraints: Up to 255 characters in length\n Constraints for EC2-Classic: ASCII characters\n Constraints for EC2-VPC: a-z, A-Z, 0-9, spaces, and ._-:/()#,@[]+=&;{}!$*",
        },
        GroupName: {
          type: "string",
          description:
            "The name of the security group.\n Constraints: Up to 255 characters in length. Cannot start with ``sg-``.\n Valid characters: a-z, A-Z, 0-9, spaces, and ._-:/()#,@[]+=&;{}!$*",
        },
        VpcId: {
          type: "string",
          description:
            "The ID of the VPC for the security group. If you do not specify a VPC, the default VPC is used.",
        },
        SecurityGroupIngress: {
          type: "array",
          description:
            "The inbound rules associated with the security group. There is a short interruption during which you cannot connect to the security group.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Ingress",
          },
        },
        SecurityGroupEgress: {
          type: "array",
          description:
            "The outbound rules associated with the security group. There is a short interruption during which you cannot connect to the security group.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Egress",
          },
        },
        Tags: {
          type: "array",
          description: "Any tags assigned to the security group.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: ["GroupDescription"],
      readOnlyProperties: ["/properties/Id", "/properties/GroupId"],
      primaryIdentifier: ["/properties/Id"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::EC2::VPC" }. 8 props in full schema, trimmed to 5. */
  vpc: {
    success: mcpText({
      typeName: "AWS::EC2::VPC",
      description:
        "Specifies a virtual private cloud (VPC).\n To add an IPv6 CIDR block to the VPC, see [AWS::EC2::VPCCidrBlock](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpccidrblock.html).",
      properties: {
        CidrBlock: {
          type: "string",
          description:
            "The IPv4 network range for the VPC, in CIDR notation. For example, ``10.0.0.0/16``. We modify the specified CIDR block to its canonical form; for example, if you specify ``100.68.0.18/18``, we modify it to ``100.68.0.0/18``.",
        },
        EnableDnsHostnames: {
          type: "boolean",
          description:
            "Indicates whether the instances launched in the VPC get DNS hostnames. If enabled, instances in the VPC get DNS hostnames; otherwise, they do not.",
        },
        EnableDnsSupport: {
          type: "boolean",
          description:
            'Indicates whether the DNS resolution is supported for the VPC. If enabled, queries to the Amazon provided DNS server at the 169.254.169.253 IP address, or the reserved IP address at the base of the VPC network range "plus two" succeed. If disabled, the Amazon provided DNS service in the VPC that resolves public DNS hostnames to IP addresses is not enabled.',
        },
        InstanceTenancy: {
          type: "string",
          description:
            "The allowed tenancy of instances launched into the VPC.\n ``default``: An instance launched into the VPC runs on shared hardware by default, unless you explicitly specify a different tenancy during instance launch.\n ``dedicated``: An instance launched into the VPC runs on dedicated hardware by default, unless you explicitly specify a tenancy of ``host`` during instance launch. You cannot specify a tenancy of ``default`` during instance launch.",
          enum: ["default", "dedicated"],
        },
        Tags: {
          type: "array",
          description: "The tags for the VPC.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: [
        "/properties/VpcId",
        "/properties/CidrBlockAssociations",
        "/properties/DefaultNetworkAcl",
        "/properties/DefaultSecurityGroup",
      ],
      primaryIdentifier: ["/properties/VpcId"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::EC2::Subnet" }. 18 props in full schema, trimmed to 5. */
  subnet: {
    success: mcpText({
      typeName: "AWS::EC2::Subnet",
      description:
        "Specifies a subnet for the specified VPC.\n For an IPv4 only subnet, specify an IPv4 CIDR block. If the VPC has an IPv6 CIDR block, you can create an IPv6 only subnet or a dual stack subnet instead. For an IPv6 only subnet, specify an IPv6 CIDR block. For a dual stack subnet, specify both an IPv4 CIDR block and an IPv6 CIDR block.",
      properties: {
        VpcId: {
          type: "string",
          description: "The ID of the VPC the subnet is in.",
        },
        CidrBlock: {
          type: "string",
          description:
            "The IPv4 CIDR block assigned to the subnet.\n If you update this property, we create a new subnet, and then delete the existing one.",
        },
        AvailabilityZone: {
          type: "string",
          description:
            "The Availability Zone of the subnet.\n If you update this property, we create a new subnet, and then delete the existing one.",
        },
        MapPublicIpOnLaunch: {
          type: "boolean",
          description:
            "Indicates whether instances launched in this subnet receive a public IPv4 address. The default value is ``false``.\n  AWS charges for all public IPv4 addresses, including public IPv4 addresses associated with running instances and Elastic IP addresses.",
        },
        Tags: {
          type: "array",
          description: "Any tags assigned to the subnet.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: ["VpcId"],
      readOnlyProperties: [
        "/properties/SubnetId",
        "/properties/AvailabilityZoneId",
        "/properties/NetworkAclAssociationId",
      ],
      primaryIdentifier: ["/properties/SubnetId"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::SQS::Queue" }. 19 props in full schema, trimmed to 8. */
  sqsQueue: {
    success: mcpText({
      typeName: "AWS::SQS::Queue",
      description:
        "The ``AWS::SQS::Queue`` resource creates an Amazon SQS standard or FIFO queue.\n Keep the following caveats in mind:\n  +  If you don't specify the ``FifoQueue`` property, Amazon SQS creates a standard queue.\n  +  If you change the value of the ``FifoQueue`` property, SQS creates a new queue and deletes the existing one.\n  +  You can't change the queue type after you create it.",
      properties: {
        QueueName: {
          type: "string",
          description:
            "A name for the queue. To create a FIFO queue, the name of your FIFO queue must end with the ``.fifo`` suffix. For more information, see [FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html) in the *Developer Guide*.\n If you don't specify a name, CFN generates a unique physical ID and uses that ID for the queue name. For more information, see [Name type](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-name.html).",
        },
        FifoQueue: {
          type: "boolean",
          description:
            "If set to true, creates a FIFO queue. If you don't specify this property, Amazon SQS creates a standard queue.",
        },
        VisibilityTimeout: {
          type: "integer",
          description:
            "The length of time during which a message will be unavailable after a message is delivered from the queue. This blocks other components from receiving the same message and gives the initial component time to process and delete the message from the queue.\n Values must be from 0 to 43,200 seconds (12 hours). If you don't specify a value, AWS CloudFormation uses the default value of 30 seconds.",
        },
        MessageRetentionPeriod: {
          type: "integer",
          description:
            "The number of seconds that Amazon SQS retains a message. You can specify an integer value from ``60`` seconds (1 minute) to ``1,209,600`` seconds (14 days). The default value is ``345,600`` seconds (4 days).",
        },
        DelaySeconds: {
          type: "integer",
          description:
            "The time in seconds for which the delivery of all messages in the queue is delayed. You can specify an integer value of ``0`` to ``900`` (15 minutes). The default value is ``0``.",
        },
        MaximumMessageSize: {
          type: "integer",
          description:
            "The limit of how many bytes that a message can contain before Amazon SQS rejects it. You can specify an integer value from ``1,024`` bytes (1 KiB) to ``262,144`` bytes (256 KiB). The default value is ``262,144`` (256 KiB).",
        },
        RedrivePolicy: {
          type: ["object", "string"],
          description:
            "The string that includes the parameters for the dead-letter queue functionality of the source queue as a JSON object.",
        },
        Tags: {
          type: "array",
          description: "The tags that you attach to this queue.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: ["/properties/QueueUrl", "/properties/Arn"],
      primaryIdentifier: ["/properties/QueueUrl"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::SNS::Topic" }. 15 props in full schema, trimmed to 5. */
  snsTopic: {
    success: mcpText({
      typeName: "AWS::SNS::Topic",
      description:
        "The ``AWS::SNS::Topic`` resource creates a topic to which notifications can be published.\n  One account can create a maximum of 100,000 standard topics and 1,000 FIFO topics. For more information, see [endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/sns.html) in the *General Reference*.",
      properties: {
        TopicName: {
          type: "string",
          description:
            "The name of the topic you want to create. Topic names must include only uppercase and lowercase ASCII letters, numbers, underscores, and hyphens, and must be between 1 and 256 characters long. FIFO topic names must end with ``.fifo``.\n If you don't specify a name, CFN generates a unique physical ID and uses that ID for the topic name.",
        },
        FifoTopic: {
          type: "boolean",
          description: "Set to true to create a FIFO topic.",
        },
        DisplayName: {
          type: "string",
          description:
            "The display name to use for an SNS topic with SMS subscriptions. The display name must be maximum 100 characters long, including hyphens (-), underscores (_), spaces, and tabs.",
        },
        KmsMasterKeyId: {
          type: "string",
          description:
            "The ID of an AWS managed customer master key (CMK) for Amazon SNS or a custom CMK. For more information, see [Key terms](https://docs.aws.amazon.com/sns/latest/dg/sns-server-side-encryption.html#sse-key-terms).",
        },
        Tags: {
          type: "array",
          description: "The list of tags to add to a new topic.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: ["/properties/TopicArn"],
      primaryIdentifier: ["/properties/TopicArn"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::ECS::Cluster" }. 9 props in full schema, trimmed to 5. */
  ecsCluster: {
    success: mcpText({
      typeName: "AWS::ECS::Cluster",
      description:
        "The ``AWS::ECS::Cluster`` resource creates an Amazon Elastic Container Service (Amazon ECS) cluster.",
      properties: {
        ClusterName: {
          type: "string",
          description:
            "A user-generated string that you use to identify your cluster. If you don't specify a name, CFNlong generates a unique physical ID for the name.",
        },
        ClusterSettings: {
          type: "array",
          description:
            "The settings to use when creating a cluster. This parameter is used to turn on CloudWatch Container Insights for a cluster.",
          items: {
            $ref: "#/definitions/ClusterSettings",
          },
        },
        CapacityProviders: {
          type: "array",
          description:
            "The short name of one or more capacity providers to associate with the cluster. A capacity provider must be associated with a cluster before it can be included as part of the default capacity provider strategy of the cluster or used in a capacity provider strategy when calling the [CreateService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_CreateService.html) or [RunTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html) actions.",
          items: {
            type: "string",
          },
        },
        DefaultCapacityProviderStrategy: {
          type: "array",
          description:
            "The default capacity provider strategy for the cluster. When services or tasks are run in the cluster with no launch type or capacity provider strategy specified, the default capacity provider strategy is used.",
          items: {
            $ref: "#/definitions/CapacityProviderStrategyItem",
          },
        },
        Tags: {
          type: "array",
          description:
            "The metadata that you apply to the cluster to help you categorize and organize them. Each tag consists of a key and an optional value. You define both.\n The following basic restrictions apply to tags:\n +  Maximum number of tags per resource - 50.\n +  For each resource, each tag key must be unique, and each tag key can have only one value.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: ["/properties/Arn"],
      primaryIdentifier: ["/properties/ClusterName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::ECR::Repository" }. 10 props in full schema, trimmed to 5. */
  ecrRepository: {
    success: mcpText({
      typeName: "AWS::ECR::Repository",
      description:
        "The ``AWS::ECR::Repository`` resource specifies an Amazon Elastic Container Registry (Amazon ECR) repository, where users can push and pull Docker images, Open Container Initiative (OCI) images, and OCI compatible artifacts.",
      properties: {
        RepositoryName: {
          type: "string",
          description:
            "The name to use for the repository. The repository name may be specified on its own (such as ``nginx-web-app``) or it can be prepended with a namespace to group the repository into a category (such as ``project-a/nginx-web-app``). If you don't specify a name, CFNlong generates a unique physical ID and uses that ID for the repository name.",
          minLength: 2,
          maxLength: 256,
          pattern:
            "^(?=.{2,256}$)((?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)$",
        },
        ImageScanningConfiguration: {
          description:
            "The image scanning configuration for the repository. This determines whether images are scanned for known vulnerabilities after being pushed to the repository.",
          $ref: "#/definitions/ImageScanningConfiguration",
        },
        ImageTagMutability: {
          type: "string",
          description:
            "The tag mutability setting for the repository. If this parameter is omitted, the default setting of ``MUTABLE`` will be used which will allow image tags to be overwritten.",
          enum: ["MUTABLE", "IMMUTABLE"],
        },
        EncryptionConfiguration: {
          description:
            "The encryption configuration for the repository. This determines how the contents of your repository are encrypted at rest.",
          $ref: "#/definitions/EncryptionConfiguration",
        },
        Tags: {
          type: "array",
          description: "An array of key-value pairs to apply to this resource.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: ["/properties/Arn", "/properties/RepositoryUri"],
      primaryIdentifier: ["/properties/RepositoryName"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { resource_type: "AWS::ElasticLoadBalancingV2::LoadBalancer" }. 12 props in full schema, trimmed to 7. */
  elbv2LoadBalancer: {
    success: mcpText({
      typeName: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      description:
        "Specifies an Application Load Balancer, a Network Load Balancer, or a Gateway Load Balancer.",
      properties: {
        Name: {
          type: "string",
          description:
            'The name of the load balancer. This name must be unique per region per account, can have a maximum of 32 characters, must contain only alphanumeric characters or hyphens, must not begin or end with a hyphen, and must not begin with "internal-".\n If you don\'t specify a name, AWS CloudFormation generates a unique physical ID for the load balancer.',
        },
        Type: {
          type: "string",
          description:
            "The type of load balancer. The default is ``application``.",
          enum: ["application", "network", "gateway"],
        },
        Scheme: {
          type: "string",
          description:
            "The nodes of an Internet-facing load balancer have public IP addresses. The DNS name of an Internet-facing load balancer is publicly resolvable to the public IP addresses of the nodes. Therefore, Internet-facing load balancers can route requests from clients over the internet.\n The nodes of an internal load balancer have only private IP addresses. The DNS name of an internal load balancer is publicly resolvable to the private IP addresses of the nodes. Therefore, internal load balancers can only route requests from clients with access to the VPC for the load balancer.\n The default is an Internet-facing load balancer.\n You cannot specify a scheme for a Gateway Load Balancer.",
          enum: ["internet-facing", "internal"],
        },
        Subnets: {
          type: "array",
          description:
            "The IDs of the subnets. You can specify only one subnet per Availability Zone. You must specify either subnets or subnet mappings, but not both.",
          insertionOrder: false,
          items: {
            type: "string",
          },
        },
        SecurityGroups: {
          type: "array",
          description: "The IDs of the security groups for the load balancer.",
          insertionOrder: false,
          items: {
            type: "string",
          },
        },
        IpAddressType: {
          type: "string",
          description:
            "The IP address type. The possible values are ``ipv4`` (for IPv4 addresses) and ``dualstack`` (for IPv4 and IPv6 addresses). You can't specify ``dualstack`` for a load balancer with a UDP or TCP_UDP listener.",
          enum: ["ipv4", "dualstack"],
        },
        Tags: {
          type: "array",
          description: "The tags to assign to the load balancer.",
          insertionOrder: false,
          items: {
            $ref: "#/definitions/Tag",
          },
        },
      },
      required: [],
      readOnlyProperties: [
        "/properties/LoadBalancerArn",
        "/properties/LoadBalancerFullName",
        "/properties/LoadBalancerName",
        "/properties/DNSName",
        "/properties/CanonicalHostedZoneID",
      ],
      primaryIdentifier: ["/properties/LoadBalancerArn"],
      additionalProperties: false,
    }),
  },

  /** Captured 2026-03-22 via DescribeType. Input: { TypeName: "AWS::Custom::FakeResource" }. Returns error (TypeNotFoundException). */
  generic: {
    success: {
      type: "text" as const,
      text: `An error occurred (TypeNotFoundException) when calling the DescribeType operation: The type 'AWS::Custom::FakeResource' cannot be found.`,
    },
  },

  /** Synthetic: empty schema edge case — DescribeType never returns empty schemas for known types. */
  empty: {
    success: mcpText({
      typeName: "AWS::Unknown::Type",
      properties: {},
    }),
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 2. aws-pricing-mcp-server — get_pricing
//    Captured 2026-03-22 via: uvx --with "botocore[crt]" awslabs.aws-pricing-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const pricingResponses = {
  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonS3", filters: [productFamily=Storage, usagetype=TimedStorage-ByteHrs] } */
  s3Storage: {
    success: mcpText({
      status: "success",
      service_name: "AmazonS3",
      data: [
        {
          product: {
            productFamily: "Storage",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "TimedStorage-ByteHrs",
              servicecode: "AmazonS3",
              servicename: "Amazon Simple Storage Service",
            },
            sku: "WP9ANXZGBYYSGJEA",
          },
          terms: {
            OnDemand: {
              "WP9ANXZGBYYSGJEA.JRTCKXETXF": {
                priceDimensions: {
                  "WP9ANXZGBYYSGJEA.JRTCKXETXF.D42MF2PVJS": {
                    unit: "GB-Mo",
                    endRange: "512000",
                    description:
                      "$0.022 per GB - next 450 TB / month of storage used",
                    appliesTo: [],
                    rateCode: "WP9ANXZGBYYSGJEA.JRTCKXETXF.D42MF2PVJS",
                    beginRange: "51200",
                    pricePerUnit: {
                      USD: "0.0220000000",
                    },
                  },
                  "WP9ANXZGBYYSGJEA.JRTCKXETXF.PXJDJ3YRG3": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description:
                      "$0.021 per GB - storage used / month over 500 TB",
                    appliesTo: [],
                    rateCode: "WP9ANXZGBYYSGJEA.JRTCKXETXF.PXJDJ3YRG3",
                    beginRange: "512000",
                    pricePerUnit: {
                      USD: "0.0210000000",
                    },
                  },
                  "WP9ANXZGBYYSGJEA.JRTCKXETXF.PGHJ3S3EYE": {
                    unit: "GB-Mo",
                    endRange: "51200",
                    description:
                      "$0.023 per GB - first 50 TB / month of storage used",
                    appliesTo: [],
                    rateCode: "WP9ANXZGBYYSGJEA.JRTCKXETXF.PGHJ3S3EYE",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0230000000",
                    },
                  },
                },
                sku: "WP9ANXZGBYYSGJEA",
                effectiveDate: "2026-02-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonS3 in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonEC2", filters: [instanceType=t3.micro, os=Linux, tenancy=Shared] } */
  ec2T3Micro: {
    success: mcpText({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Compute Instance",
            attributes: {
              instanceType: "t3.micro",
              operatingSystem: "Linux",
              tenancy: "Shared",
              regionCode: "us-east-1",
              usagetype: "BoxUsage:t3.micro",
              capacitystatus: "Used",
              preInstalledSw: "NA",
              servicecode: "AmazonEC2",
              servicename: "Amazon Elastic Compute Cloud",
              memory: "1 GiB",
              vcpu: "2",
              storage: "EBS only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "CRAJUW7BTXFMT2UJ",
          },
          terms: {
            OnDemand: {
              "CRAJUW7BTXFMT2UJ.JRTCKXETXF": {
                priceDimensions: {
                  "CRAJUW7BTXFMT2UJ.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$0.0104 per On Demand Linux t3.micro Instance Hour",
                    appliesTo: [],
                    rateCode: "CRAJUW7BTXFMT2UJ.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0104000000",
                    },
                  },
                },
                sku: "CRAJUW7BTXFMT2UJ",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonEC2 in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonEC2", filters: [instanceType=t3.small, os=Linux, tenancy=Shared] } */
  ec2T3Small: {
    success: mcpText({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Compute Instance",
            attributes: {
              instanceType: "t3.small",
              operatingSystem: "Linux",
              tenancy: "Shared",
              regionCode: "us-east-1",
              usagetype: "BoxUsage:t3.small",
              capacitystatus: "Used",
              preInstalledSw: "NA",
              servicecode: "AmazonEC2",
              servicename: "Amazon Elastic Compute Cloud",
              memory: "2 GiB",
              vcpu: "2",
              storage: "EBS only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "QA3NBPZEQKZ2K9AR",
          },
          terms: {
            OnDemand: {
              "QA3NBPZEQKZ2K9AR.JRTCKXETXF": {
                priceDimensions: {
                  "QA3NBPZEQKZ2K9AR.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$0.0208 per On Demand Linux t3.small Instance Hour",
                    appliesTo: [],
                    rateCode: "QA3NBPZEQKZ2K9AR.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0208000000",
                    },
                  },
                },
                sku: "QA3NBPZEQKZ2K9AR",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonEC2 in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonEC2", filters: [instanceType=m5.large, os=Linux, tenancy=Shared] } */
  ec2M5Large: {
    success: mcpText({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Compute Instance",
            attributes: {
              instanceType: "m5.large",
              operatingSystem: "Linux",
              tenancy: "Shared",
              regionCode: "us-east-1",
              usagetype: "BoxUsage:m5.large",
              capacitystatus: "Used",
              preInstalledSw: "NA",
              servicecode: "AmazonEC2",
              servicename: "Amazon Elastic Compute Cloud",
              memory: "8 GiB",
              vcpu: "2",
              storage: "EBS only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "6C86BEPQVG73ZGGR",
          },
          terms: {
            OnDemand: {
              "6C86BEPQVG73ZGGR.JRTCKXETXF": {
                priceDimensions: {
                  "6C86BEPQVG73ZGGR.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$0.096 per On Demand Linux m5.large Instance Hour",
                    appliesTo: [],
                    rateCode: "6C86BEPQVG73ZGGR.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0960000000",
                    },
                  },
                },
                sku: "6C86BEPQVG73ZGGR",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonEC2 in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonRDS", filters: [instanceType=db.t3.micro, engine=PostgreSQL, deployment=Single-AZ] } */
  rdsT3MicroPostgres: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.t3.micro",
              regionCode: "us-east-1",
              usagetype: "InstanceUsage:db.t3.micro",
              databaseEngine: "PostgreSQL",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "1 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "TGN7QDJF2AGFU9XA",
          },
          terms: {
            OnDemand: {
              "TGN7QDJF2AGFU9XA.JRTCKXETXF": {
                priceDimensions: {
                  "TGN7QDJF2AGFU9XA.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "USD 0.018 per db.t3.micro Single-AZ instance hour (or partial hour) running PostgreSQL",
                    appliesTo: [],
                    rateCode: "TGN7QDJF2AGFU9XA.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0180000000",
                    },
                  },
                },
                sku: "TGN7QDJF2AGFU9XA",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonRDS", filters: [instanceType=db.t3.micro, engine=MySQL, deployment=Single-AZ] } */
  rdsT3MicroMysql: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.t3.micro",
              regionCode: "us-east-1",
              usagetype: "InstanceUsage:db.t3.micro",
              databaseEngine: "MySQL",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "1 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "AXC2TYPWXFK88MVY",
          },
          terms: {
            OnDemand: {
              "AXC2TYPWXFK88MVY.JRTCKXETXF": {
                priceDimensions: {
                  "AXC2TYPWXFK88MVY.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "USD 0.017 per db.t3.micro Single-AZ instance hour (or partial hour) running MySQL",
                    appliesTo: [],
                    rateCode: "AXC2TYPWXFK88MVY.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0170000000",
                    },
                  },
                },
                sku: "AXC2TYPWXFK88MVY",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonRDS", filters: [instanceType=db.r6g.large, engine=Aurora PostgreSQL] }. 2 items captured, 1 kept. */
  rdsR6gLargeAuroraPostgres: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.r6g.large",
              regionCode: "us-east-1",
              usagetype: "InstanceUsage:db.r6g.large",
              databaseEngine: "Aurora PostgreSQL",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "16 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "Memory optimized",
            },
            sku: "4U9P9G87PY8QVQH5",
          },
          terms: {
            OnDemand: {
              "4U9P9G87PY8QVQH5.JRTCKXETXF": {
                priceDimensions: {
                  "4U9P9G87PY8QVQH5.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$ 0.26 per RDS db.r6g.large Single-AZ instance hour (or partial hour) running Aurora PostgreSQL",
                    appliesTo: [],
                    rateCode: "4U9P9G87PY8QVQH5.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.2600000000",
                    },
                  },
                },
                sku: "4U9P9G87PY8QVQH5",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonRDS", filters: [instanceType=db.r6g.large, engine=Aurora MySQL] }. 2 items captured, 1 kept. */
  rdsR6gLargeAuroraMysql: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.r6g.large",
              regionCode: "us-east-1",
              usagetype: "InstanceUsage:db.r6g.large",
              databaseEngine: "Aurora MySQL",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "16 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "Memory optimized",
            },
            sku: "SVB4AAU3H83DPGMK",
          },
          terms: {
            OnDemand: {
              "SVB4AAU3H83DPGMK.JRTCKXETXF": {
                priceDimensions: {
                  "SVB4AAU3H83DPGMK.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$ 0.26 per RDS db.r6g.large Single-AZ instance hour (or partial hour) running Aurora MySQL",
                    appliesTo: [],
                    rateCode: "SVB4AAU3H83DPGMK.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.2600000000",
                    },
                  },
                },
                sku: "SVB4AAU3H83DPGMK",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonRDS", filters: [instanceType=db.t3.micro, engine=MariaDB, deployment=Single-AZ] } */
  rdsT3MicroMariadb: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.t3.micro",
              regionCode: "us-east-1",
              usagetype: "InstanceUsage:db.t3.micro",
              databaseEngine: "MariaDB",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "1 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "5J8PBWJNX88YGMQK",
          },
          terms: {
            OnDemand: {
              "5J8PBWJNX88YGMQK.JRTCKXETXF": {
                priceDimensions: {
                  "5J8PBWJNX88YGMQK.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "USD 0.017 per db.t3.micro Single-AZ instance hour (or partial hour) running MariaDB",
                    appliesTo: [],
                    rateCode: "5J8PBWJNX88YGMQK.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0170000000",
                    },
                  },
                },
                sku: "5J8PBWJNX88YGMQK",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AWSSystemsManager", filters: [productFamily=AWS Systems Manager] }. 34 items captured, 1 kept. */
  ssmParameter: {
    success: mcpText({
      status: "success",
      service_name: "AWSSystemsManager",
      data: [
        {
          product: {
            productFamily: "AWS Systems Manager",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "USE1-SmAdvParamStorageHrs",
              servicecode: "AWSSystemsManager",
              servicename: "AWS Systems Manager",
            },
            sku: "2SC234H95RE9KUWA",
          },
          terms: {
            OnDemand: {
              "2SC234H95RE9KUWA.JRTCKXETXF": {
                priceDimensions: {
                  "2SC234H95RE9KUWA.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "API Requests",
                    endRange: "Inf",
                    description:
                      "SSM Parameter Storage in US East (N. Virginia)",
                    appliesTo: [],
                    rateCode: "2SC234H95RE9KUWA.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0000700000",
                    },
                  },
                },
                sku: "2SC234H95RE9KUWA",
                effectiveDate: "2025-08-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20250828153807",
          publicationDate: "2025-08-28T15:38:07Z",
        },
      ],
      message:
        "Retrieved pricing for AWSSystemsManager in us-east-1 from AWS Pricing API",
    }),
  },

  /** EC2 decomposer: EBS gp3 storage. Input: { service_code: "AmazonEC2", filters: [productFamily=Storage, volumeApiName=gp3] } */
  ebsGp3Storage: {
    success: mcpText({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Storage",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "EBS:VolumeUsage.gp3",
              volumeApiName: "gp3",
              servicecode: "AmazonEC2",
              servicename: "Amazon Elastic Compute Cloud",
            },
            sku: "GP3VOLSKU00001",
          },
          terms: {
            OnDemand: {
              "GP3VOLSKU00001.JRTCKXETXF": {
                priceDimensions: {
                  "GP3VOLSKU00001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description:
                      "$0.08 per GB-month of General Purpose (gp3) provisioned storage",
                    appliesTo: [],
                    rateCode: "GP3VOLSKU00001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0800000000",
                    },
                  },
                },
                sku: "GP3VOLSKU00001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonEC2 in us-east-1 from AWS Pricing API",
    }),
  },

  /** EC2 decomposer: Public IPv4 address. Input: { service_code: "AmazonVPC", filters: [productFamily=IP Address, group=ElasticIP:Address] } */
  publicIpv4: {
    success: mcpText({
      status: "success",
      service_name: "AmazonVPC",
      data: [
        {
          product: {
            productFamily: "IP Address",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "ElasticIP:IdleAddress",
              group: "ElasticIP:Address",
              servicecode: "AmazonVPC",
              servicename: "Amazon Virtual Private Cloud",
            },
            sku: "IPV4ADDRSKU0001",
          },
          terms: {
            OnDemand: {
              "IPV4ADDRSKU0001.JRTCKXETXF": {
                priceDimensions: {
                  "IPV4ADDRSKU0001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$0.005 per Elastic IP address not attached to a running instance per hour",
                    appliesTo: [],
                    rateCode: "IPV4ADDRSKU0001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0050000000",
                    },
                  },
                },
                sku: "IPV4ADDRSKU0001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonVPC in us-east-1 from AWS Pricing API",
    }),
  },

  /** EC2 decomposer: Data transfer out. Input: { service_code: "AWSDataTransfer", filters: [productFamily=Data Transfer, transferType=AWS Outbound] } */
  dataTransferOut: {
    success: mcpText({
      status: "success",
      service_name: "AWSDataTransfer",
      data: [
        {
          product: {
            productFamily: "Data Transfer",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "DataTransfer-Out-Bytes",
              fromLocationType: "AWS Region",
              toLocationType: "External",
              transferType: "AWS Outbound",
              servicecode: "AWSDataTransfer",
              servicename: "AWS Data Transfer",
            },
            sku: "DTOUTSKU000001",
          },
          terms: {
            OnDemand: {
              "DTOUTSKU000001.JRTCKXETXF": {
                priceDimensions: {
                  "DTOUTSKU000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB",
                    endRange: "Inf",
                    description: "$0.09 per GB - data transfer out to Internet",
                    appliesTo: [],
                    rateCode: "DTOUTSKU000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0900000000",
                    },
                  },
                },
                sku: "DTOUTSKU000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AWSDataTransfer in us-east-1 from AWS Pricing API",
    }),
  },

  /** RDS decomposer: Multi-AZ compute. Input: { service_code: "AmazonRDS", filters: [instanceType=db.t3.micro, engine=PostgreSQL, deployment=Multi-AZ] } */
  rdsT3MicroPostgresMultiAZ: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Instance",
            attributes: {
              instanceType: "db.t3.micro",
              regionCode: "us-east-1",
              usagetype: "Multi-AZUsage:db.t3.micro",
              databaseEngine: "PostgreSQL",
              deploymentOption: "Multi-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
              memory: "1 GiB",
              vcpu: "2",
              storage: "EBS Only",
              currentGeneration: "Yes",
              instanceFamily: "General purpose",
            },
            sku: "RDSMAZ7QDJF2AG01",
          },
          terms: {
            OnDemand: {
              "RDSMAZ7QDJF2AG01.JRTCKXETXF": {
                priceDimensions: {
                  "RDSMAZ7QDJF2AG01.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "USD 0.036 per db.t3.micro Multi-AZ instance hour (or partial hour) running PostgreSQL",
                    appliesTo: [],
                    rateCode: "RDSMAZ7QDJF2AG01.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0360000000",
                    },
                  },
                },
                sku: "RDSMAZ7QDJF2AG01",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
            Reserved: "<filtered by output_options.pricing_terms>",
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** RDS decomposer: Database storage gp3. Input: { service_code: "AmazonRDS", filters: [productFamily=Database Storage, volumeType=General Purpose (SSD)] } */
  rdsStorageGp3: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Database Storage",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "RDS:GP3-Storage",
              volumeType: "General Purpose (SSD)",
              deploymentOption: "Single-AZ",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
            },
            sku: "RDSSTRGP3SK0001",
          },
          terms: {
            OnDemand: {
              "RDSSTRGP3SK0001.JRTCKXETXF": {
                priceDimensions: {
                  "RDSSTRGP3SK0001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description:
                      "$0.023 per GB-month of General Purpose (SSD) gp3 provisioned storage",
                    appliesTo: [],
                    rateCode: "RDSSTRGP3SK0001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0230000000",
                    },
                  },
                },
                sku: "RDSSTRGP3SK0001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** RDS decomposer: Backup (storage snapshot). Input: { service_code: "AmazonRDS", filters: [productFamily=Storage Snapshot] } */
  rdsBackupStorage: {
    success: mcpText({
      status: "success",
      service_name: "AmazonRDS",
      data: [
        {
          product: {
            productFamily: "Storage Snapshot",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "RDS:ChargedBackupUsage",
              servicecode: "AmazonRDS",
              servicename: "Amazon Relational Database Service",
            },
            sku: "RDSBKUPSK000001",
          },
          terms: {
            OnDemand: {
              "RDSBKUPSK000001.JRTCKXETXF": {
                priceDimensions: {
                  "RDSBKUPSK000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description: "$0.018 per GB-month of backup storage used",
                    appliesTo: [],
                    rateCode: "RDSBKUPSK000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0180000000",
                    },
                  },
                },
                sku: "RDSBKUPSK000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260318225923",
          publicationDate: "2026-03-18T22:59:23Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonRDS in us-east-1 from AWS Pricing API",
    }),
  },

  /** S3 decomposer: PUT requests. Input: { service_code: "AmazonS3", filters: [productFamily=API Request, usagetype=Requests-Tier1] } */
  s3PutRequests: {
    success: mcpText({
      status: "success",
      service_name: "AmazonS3",
      data: [
        {
          product: {
            productFamily: "API Request",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "Requests-Tier1",
              group: "S3-API-Tier1",
              servicecode: "AmazonS3",
              servicename: "Amazon Simple Storage Service",
            },
            sku: "S3PUTREQSKU0001",
          },
          terms: {
            OnDemand: {
              "S3PUTREQSKU0001.JRTCKXETXF": {
                priceDimensions: {
                  "S3PUTREQSKU0001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description:
                      "$0.005 per 1,000 PUT, COPY, POST, or LIST requests",
                    appliesTo: [],
                    rateCode: "S3PUTREQSKU0001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0050000000",
                    },
                  },
                },
                sku: "S3PUTREQSKU0001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonS3 in us-east-1 from AWS Pricing API",
    }),
  },

  /** S3 decomposer: GET requests. Input: { service_code: "AmazonS3", filters: [productFamily=API Request, usagetype=Requests-Tier2] } */
  s3GetRequests: {
    success: mcpText({
      status: "success",
      service_name: "AmazonS3",
      data: [
        {
          product: {
            productFamily: "API Request",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "Requests-Tier2",
              group: "S3-API-Tier2",
              servicecode: "AmazonS3",
              servicename: "Amazon Simple Storage Service",
            },
            sku: "S3GETREQSKU0001",
          },
          terms: {
            OnDemand: {
              "S3GETREQSKU0001.JRTCKXETXF": {
                priceDimensions: {
                  "S3GETREQSKU0001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description: "$0.0004 per 1,000 GET and all other requests",
                    appliesTo: [],
                    rateCode: "S3GETREQSKU0001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0004000000",
                    },
                  },
                },
                sku: "S3GETREQSKU0001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonS3 in us-east-1 from AWS Pricing API",
    }),
  },

  /** S3 decomposer: Data Transfer. Input: { service_code: "AWSDataTransfer", filters: [productFamily=Data Transfer, usagetype=DataTransfer-Out-Bytes] } */
  s3DataTransfer: {
    success: mcpText({
      status: "success",
      service_name: "AWSDataTransfer",
      data: [
        {
          product: {
            productFamily: "Data Transfer",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "DataTransfer-Out-Bytes",
              transferType: "AWS Outbound",
              fromLocation: "US East (N. Virginia)",
              fromLocationType: "AWS Region",
              toLocation: "External",
              toLocationType: "Other",
              servicecode: "AWSDataTransfer",
              servicename: "AWS Data Transfer",
            },
            sku: "DTOUTSKU00000001",
          },
          terms: {
            OnDemand: {
              "DTOUTSKU00000001.JRTCKXETXF": {
                priceDimensions: {
                  "DTOUTSKU00000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB",
                    endRange: "Inf",
                    description:
                      "$0.09 per GB - next 9.999 TB / month data transfer out beyond the global free tier",
                    appliesTo: [],
                    rateCode: "DTOUTSKU00000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "1",
                    pricePerUnit: {
                      USD: "0.0900000000",
                    },
                  },
                },
                sku: "DTOUTSKU00000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message:
        "Retrieved pricing for AWSDataTransfer in us-east-1 from AWS Pricing API",
    }),
  },

  /** Lambda decomposer: Requests. Input: { service_code: "AWSLambda", filters: [productFamily=Serverless, group=AWS-Lambda-Requests, usagetype=Request] } */
  lambdaRequests: {
    success: mcpText({
      status: "success",
      service_name: "AWSLambda",
      data: [
        {
          product: {
            productFamily: "Serverless",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "Request",
              group: "AWS-Lambda-Requests",
              servicecode: "AWSLambda",
              servicename: "AWS Lambda",
            },
            sku: "LMBREQSKU000001",
          },
          terms: {
            OnDemand: {
              "LMBREQSKU000001.JRTCKXETXF": {
                priceDimensions: {
                  "LMBREQSKU000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description: "$0.20 per 1M requests",
                    appliesTo: [],
                    rateCode: "LMBREQSKU000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.2000000000",
                    },
                  },
                },
                sku: "LMBREQSKU000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AWSLambda in us-east-1 from AWS Pricing API",
    }),
  },

  /** Lambda decomposer: Duration (GB-second). Input: { service_code: "AWSLambda", filters: [productFamily=Serverless, group=AWS-Lambda-Duration, usagetype=Lambda-GB-Second] } */
  lambdaDuration: {
    success: mcpText({
      status: "success",
      service_name: "AWSLambda",
      data: [
        {
          product: {
            productFamily: "Serverless",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "Lambda-GB-Second",
              group: "AWS-Lambda-Duration",
              servicecode: "AWSLambda",
              servicename: "AWS Lambda",
            },
            sku: "LMBDURSKU000001",
          },
          terms: {
            OnDemand: {
              "LMBDURSKU000001.JRTCKXETXF": {
                priceDimensions: {
                  "LMBDURSKU000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Second",
                    endRange: "Inf",
                    description: "$0.0000166667 per GB-second",
                    appliesTo: [],
                    rateCode: "LMBDURSKU000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0000166667",
                    },
                  },
                },
                sku: "LMBDURSKU000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AWSLambda in us-east-1 from AWS Pricing API",
    }),
  },

  /** Lambda decomposer: CloudWatch Logs. Input: { service_code: "AmazonCloudWatch", filters: [productFamily=Data Payload, group=CW:Logs, usagetype=DataProcessing-Bytes] } */
  cloudWatchLogs: {
    success: mcpText({
      status: "success",
      service_name: "AmazonCloudWatch",
      data: [
        {
          product: {
            productFamily: "Data Payload",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "DataProcessing-Bytes",
              group: "CW:Logs",
              servicecode: "AmazonCloudWatch",
              servicename: "Amazon CloudWatch",
            },
            sku: "CWLOGSKU00000001",
          },
          terms: {
            OnDemand: {
              "CWLOGSKU00000001.JRTCKXETXF": {
                priceDimensions: {
                  "CWLOGSKU00000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB",
                    endRange: "Inf",
                    description: "$0.50 per GB of log data ingested",
                    appliesTo: [],
                    rateCode: "CWLOGSKU00000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.5000000000",
                    },
                  },
                },
                sku: "CWLOGSKU00000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonCloudWatch in us-east-1 from AWS Pricing API",
    }),
  },

  /** SQS Standard queue requests. Input: { service_code: "AmazonSQS", filters: [productFamily=API Request, queueType=Standard] } */
  sqsStandardRequests: {
    success: mcpText({
      status: "success",
      service_name: "AmazonSQS",
      data: [
        {
          product: {
            productFamily: "API Request",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "USE1-Requests-Tier1",
              queueType: "Standard",
              servicecode: "AmazonSQS",
              servicename: "Amazon Simple Queue Service",
            },
            sku: "SQSSTDREQ0000001",
          },
          terms: {
            OnDemand: {
              "SQSSTDREQ0000001.JRTCKXETXF": {
                priceDimensions: {
                  "SQSSTDREQ0000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description:
                      "$0.40 per million Amazon SQS Requests per month for Standard queue",
                    appliesTo: [],
                    rateCode: "SQSSTDREQ0000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0000004000",
                    },
                  },
                },
                sku: "SQSSTDREQ0000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonSQS in us-east-1 from AWS Pricing API",
    }),
  },

  /** SQS FIFO queue requests. Input: { service_code: "AmazonSQS", filters: [productFamily=API Request, queueType=FIFO] } */
  sqsFifoRequests: {
    success: mcpText({
      status: "success",
      service_name: "AmazonSQS",
      data: [
        {
          product: {
            productFamily: "API Request",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "USE1-Requests-FIFO-Tier1",
              queueType: "FIFO",
              servicecode: "AmazonSQS",
              servicename: "Amazon Simple Queue Service",
            },
            sku: "SQSFIFOREQ000001",
          },
          terms: {
            OnDemand: {
              "SQSFIFOREQ000001.JRTCKXETXF": {
                priceDimensions: {
                  "SQSFIFOREQ000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description:
                      "$0.50 per million Amazon SQS Requests per month for FIFO queue",
                    appliesTo: [],
                    rateCode: "SQSFIFOREQ000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0000005000",
                    },
                  },
                },
                sku: "SQSFIFOREQ000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonSQS in us-east-1 from AWS Pricing API",
    }),
  },

  /** SNS publishes. Input: { service_code: "AmazonSNS", filters: [productFamily=API Request, group=SNS-Requests-Tier1] } */
  snsPublishes: {
    success: mcpText({
      status: "success",
      service_name: "AmazonSNS",
      data: [
        {
          product: {
            productFamily: "API Request",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "USE1-Requests-Tier1",
              group: "SNS-Requests-Tier1",
              servicecode: "AmazonSNS",
              servicename: "Amazon Simple Notification Service",
            },
            sku: "SNSPUBREQSK00001",
          },
          terms: {
            OnDemand: {
              "SNSPUBREQSK00001.JRTCKXETXF": {
                priceDimensions: {
                  "SNSPUBREQSK00001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Requests",
                    endRange: "Inf",
                    description: "$0.50 per million Amazon SNS requests",
                    appliesTo: [],
                    rateCode: "SNSPUBREQSK00001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0000005000",
                    },
                  },
                },
                sku: "SNSPUBREQSK00001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonSNS in us-east-1 from AWS Pricing API",
    }),
  },

  /** ECR storage. Input: { service_code: "AmazonECR", filters: [productFamily=EC2 Container Registry, usagetype=USE1-TimedStorage-ByteHrs] } */
  ecrStorage: {
    success: mcpText({
      status: "success",
      service_name: "AmazonECR",
      data: [
        {
          product: {
            productFamily: "EC2 Container Registry",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "USE1-TimedStorage-ByteHrs",
              servicecode: "AmazonECR",
              servicename: "Amazon EC2 Container Registry",
            },
            sku: "ECRSTORSKU000001",
          },
          terms: {
            OnDemand: {
              "ECRSTORSKU000001.JRTCKXETXF": {
                priceDimensions: {
                  "ECRSTORSKU000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description:
                      "$0.10 per GB per month for data stored in private or public repositories",
                    appliesTo: [],
                    rateCode: "ECRSTORSKU000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.1000000000",
                    },
                  },
                },
                sku: "ECRSTORSKU000001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message:
        "Retrieved pricing for AmazonECR in us-east-1 from AWS Pricing API",
    }),
  },

  /** ELBv2 ALB hourly charge. Input: { service_code: "AWSELB", filters: [productFamily=Load Balancer-Application, usagetype=LoadBalancerUsage] } */
  elbv2AlbHourly: {
    success: mcpText({
      status: "success",
      service_name: "AWSELB",
      data: [
        {
          product: {
            productFamily: "Load Balancer-Application",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "LoadBalancerUsage",
              group: "ELB:Balancer",
              servicecode: "AWSELB",
              servicename: "Elastic Load Balancing",
            },
            sku: "ELBALBHRSKU00001",
          },
          terms: {
            OnDemand: {
              "ELBALBHRSKU00001.JRTCKXETXF": {
                priceDimensions: {
                  "ELBALBHRSKU00001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description:
                      "$0.0225 per Application Load Balancer-hour (or partial hour)",
                    appliesTo: [],
                    rateCode: "ELBALBHRSKU00001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0225000000",
                    },
                  },
                },
                sku: "ELBALBHRSKU00001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message: "Retrieved pricing for AWSELB in us-east-1 from AWS Pricing API",
    }),
  },

  /** ELBv2 ALB LCU-hour. Input: { service_code: "AWSELB", filters: [productFamily=Load Balancer-Application, usagetype=LCUUsage] } */
  elbv2AlbLcu: {
    success: mcpText({
      status: "success",
      service_name: "AWSELB",
      data: [
        {
          product: {
            productFamily: "Load Balancer-Application",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "LCUUsage",
              group: "ELB:Balancer",
              servicecode: "AWSELB",
              servicename: "Elastic Load Balancing",
            },
            sku: "ELBALBLCUSKU0001",
          },
          terms: {
            OnDemand: {
              "ELBALBLCUSKU0001.JRTCKXETXF": {
                priceDimensions: {
                  "ELBALBLCUSKU0001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "Hrs",
                    endRange: "Inf",
                    description: "$0.008 per LCU-hour (or partial hour)",
                    appliesTo: [],
                    rateCode: "ELBALBLCUSKU0001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: {
                      USD: "0.0080000000",
                    },
                  },
                },
                sku: "ELBALBLCUSKU0001",
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260320042925",
          publicationDate: "2026-03-20T04:29:25Z",
        },
      ],
      message: "Retrieved pricing for AWSELB in us-east-1 from AWS Pricing API",
    }),
  },

  /** Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: "AmazonEC2", filters: [instanceType=z99.nonexistent] }. Server returns error with suggestion. */
  emptyData: {
    success: mcpText({
      status: "error",
      error_type: "empty_results",
      message:
        "No results found for given filters [[PricingFilter(field='productFamily', type='TERM_MATCH', value='Compute Instance'), PricingFilter(field='instanceType', type='TERM_MATCH', value='z99.nonexistent'), PricingFilter(field='operatingSystem', type='TERM_MATCH', value='Linux')]], service: \"AmazonEC2\", region \"us-east-1\"",
      service_code: "AmazonEC2",
      region: "us-east-1",
      suggestion:
        "Try these approaches: (1) Verify that the service code is valid. Use get_service_codes() to get valid service codes. (2) Validate region and filter values using get_pricing_attribute_values(). (3) Test with fewer filters to isolate the issue.",
      examples: {
        "Example service codes": [
          "AmazonEC2",
          "AmazonS3",
          "AmazonES",
          "AWSLambda",
          "AmazonDynamoDB",
        ],
        "Example regions": ["us-east-1", "eu-west-1", "ap-south-1"],
      },
    }),
  },

  /** Synthetic: zero-price response — constructed for free-tier edge case testing. */
  zeroPrice: {
    success: mcpText({
      data: [
        {
          terms: {
            OnDemand: {
              "TERM-FREE": {
                priceDimensions: {
                  "DIM-FREE": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000000000" },
                  },
                },
              },
            },
          },
        },
      ],
    }),
  },

  /** Synthetic: empty response object — MCP server returned valid JSON but no data key. */
  emptyResponse: {
    success: mcpText({}),
  },

  /** Synthetic: malformed response — text field is not valid JSON. */
  malformedJson: {
    success: { type: "text" as const, text: "not valid json {{{" },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 3. aws-documentation-mcp-server — search_documentation
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docSearchResponses = {
  /** Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: "BucketName AWS::S3::Bucket" }. 10 results, 3 kept. */
  s3BucketName: {
    success: {
      query_id: "q-s3-bucket-name-001",
      search_results: [
        {
          rank_order: 1,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-s3-bucket.html",
          title: "AWS::S3::Bucket - AWS CloudFormation",
          context: "Use the CloudFormation AWS::S3::Bucket resource for S3.",
        },
        {
          rank_order: 2,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html",
          title: "AWS::S3::Bucket - AWS CloudFormation",
          context:
            "Use the AWS CloudFormation AWS::S3::Bucket resource for S3.",
        },
        {
          rank_order: 3,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-cors-corsrule.html",
          title: "AWS::S3::Bucket CorsRule - AWS CloudFormation",
          context:
            "Specifies a cross-origin access rule for an Amazon S3 bucket.",
        },
      ],
      facets: {},
    },
  },

  /** Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: "InstanceType AWS::EC2::Instance" } */
  ec2InstanceType: {
    success: {
      query_id: "q-ec2-instance-type-001",
      search_results: [
        {
          rank_order: 1,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-instance.html",
          title: "AWS::EC2::Instance - AWS CloudFormation",
          context: "Specifies an EC2 instance.",
        },
        {
          rank_order: 2,
          url: "https://docs.aws.amazon.com/cdk/api/v1/docs/@aws-cdk_aws-ec2.InstanceType.html",
          title: "class InstanceType · AWS CDK",
          context: "# class InstanceType",
        },
        {
          rank_order: 3,
          url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-discovery.html",
          title:
            "Find an Amazon EC2 instance type - Amazon Elastic Compute Cloud",
          context:
            "Discover suitable EC2 instance types based on compute, memory, storage needs. Filter by Availability Zone, memory size, instance storage, hibernation support.",
        },
      ],
      facets: {},
    },
  },

  /** Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: "Runtime AWS::Lambda::Function" } */
  lambdaRuntime: {
    success: {
      query_id: "q-lambda-runtime-001",
      search_results: [
        {
          rank_order: 1,
          url: "https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html",
          title: "Working with Lambda environment variables - AWS Lambda",
          context:
            "Configure Lambda environment variables customize function behavior, encrypt secrets, manage keys console.",
        },
        {
          rank_order: 2,
          url: "https://docs.aws.amazon.com/lambda/latest/dg/runtime-management-configure-settings.html",
          title: "Configuring Lambda runtime management settings - AWS Lambda",
          context:
            "Lambda runtime management settings allow configuring automatic updates, updates on function changes, or manual updates with runtime version ARNs via console or CLI.",
        },
        {
          rank_order: 3,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-version-runtimepolicy.html",
          title: "AWS::Lambda::Version RuntimePolicy - AWS CloudFormation",
          context:
            "Use the CloudFormation AWS::Lambda::Version.RuntimePolicy resource for Lambda.",
        },
      ],
      facets: {},
    },
  },

  /** Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: "Engine AWS::RDS::DBInstance" } */
  rdsEngine: {
    success: {
      query_id: "q-rds-engine-001",
      search_results: [
        {
          rank_order: 1,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-rds-dbinstance.html",
          title: "AWS::RDS::DBInstance - AWS CloudFormation",
          context:
            "Use the CloudFormation AWS::RDS::DBInstance resource for RDS.",
        },
        {
          rank_order: 2,
          url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-rds-dbinstance-dbinstancerole.html",
          title: "AWS::RDS::DBInstance DBInstanceRole - AWS CloudFormation",
          context:
            "Use the CloudFormation AWS::RDS::DBInstance.DBInstanceRole resource for RDS.",
        },
        {
          rank_order: 3,
          url: "https://docs.aws.amazon.com/sdk-for-cpp/latest/api/aws-cpp-sdk-rds/html/class_aws_1_1_r_d_s_1_1_model_1_1_d_b_instance.html",
          title: "AWS SDK for C++: Aws::RDS::Model::DBInstance Class Reference",
          context:
            "Aws::RDS::Model::DBInstance Class Reference - AWS SDK for C++ v1",
        },
      ],
      facets: {},
    },
  },

  /** Synthetic: unstructured response — URL embedded in plain text (regex fallback path). */
  unstructuredWithUrl: {
    success:
      "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
  },

  /** Synthetic: empty search results — no URLs in structured response. */
  emptyResults: {
    success: {
      structuredContent: {
        search_results: [],
      },
    },
  },

  /** Synthetic: no results — plain text response with no URL. */
  noResultsText: {
    success: "No results found for the given search phrase.",
  },

  /** Synthetic: null response — server returned nothing. */
  nullResponse: {
    success: null,
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 4. aws-documentation-mcp-server — read_sections
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docReadSectionsResponses = {
  /** Captured 2026-03-22 from aws-documentation-mcp-server read_sections. Input: { url: CFN S3 Bucket page, section_titles: [Overview,Description,Properties,Syntax] }. Truncated from 24K chars. */
  s3BucketName: {
    success: {
      result: `## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::S3::Bucket",
  "Properties" : {
      "AbacStatus" : String,
      "AccelerateConfiguration" : AccelerateConfiguration,
      "AccessControl" : String,
      "AnalyticsConfigurations" : [ AnalyticsConfiguration, ... ],
      "BucketEncryption" : BucketEncryption,
      "BucketName" : String,
      "BucketNamePrefix" : String,
      "BucketNamespace" : String,
      "CorsConfiguration" : CorsConfiguration,
      "IntelligentTieringConfigurations" : [ IntelligentTieringConfiguration, ... ],
      "InventoryConfigurations" : [ InventoryConfiguration, ... ],
      "LifecycleConfiguration" : LifecycleConfiguration,
      "LoggingConfiguration" : LoggingConfiguration,
      "MetadataConfiguration" : MetadataConfiguration,
      "MetadataTableConfiguration" : MetadataTableConfiguration,
      "MetricsConfigurations" : [ MetricsConfiguration, ... ],
      "NotificationConfiguration" : NotificationConfiguration,
      "ObjectLockConfiguration" : ObjectLockConfiguration,
      "ObjectLockEnabled" : Boolean,
      "OwnershipControls" : OwnershipControls,
      "PublicAccessBlockConfiguration" : PublicAccessBlockConfiguration,
      "ReplicationConfiguration" : ReplicationConfiguration,
      "Tags" : [ Tag, ... ],
      "VersioningConfiguration" : VersioningConfiguration,
      "WebsiteConfiguration" : WebsiteConfiguration
    }
}
\`\`\`

### YAML

\`\`\`
Type: AWS::S3::Bucket
Properties:
  AbacStatus: String
  AccelerateConfiguration:
    AccelerateConfiguration
  AccessControl: String
  AnalyticsConfigurations:
    - AnalyticsConfiguration
  BucketEncryption:
    BucketEncryption
  BucketName: String
  BucketNamePrefix: String
  BucketNamespace: String
  CorsConfiguration:
    CorsConfiguration
  IntelligentTieringConfigurations:
    - IntelligentTieringConfiguration
  InventoryConfigurations:
    - InventoryConfiguration
  LifecycleConfiguration:


[Content truncated for test fixture]`,
    },
  },

  /** Captured 2026-03-22. read_sections on CFN EC2 Instance page. Truncated from 50K chars. */
  ec2InstanceType: {
    success: {
      result: `## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::EC2::Instance",
  "Properties" : {
      "AdditionalInfo" : String,
      "Affinity" : String,
      "AvailabilityZone" : String,
      "BlockDeviceMappings" : [ BlockDeviceMapping, ... ],
      "CpuOptions" : CpuOptions,
      "CreditSpecification" : CreditSpecification,
      "DisableApiTermination" : Boolean,
      "EbsOptimized" : Boolean,
      "ElasticGpuSpecifications" : [ ElasticGpuSpecification, ... ],
      "ElasticInferenceAccelerators" : [ ElasticInferenceAccelerator, ... ],
      "EnclaveOptions" : EnclaveOptions,
      "HibernationOptions" : HibernationOptions,
      "HostId" : String,
      "HostResourceGroupArn" : String,
      "IamInstanceProfile" : String,
      "ImageId" : String,
      "InstanceInitiatedShutdownBehavior" : String,
      "InstanceType" : String,
      "Ipv6AddressCount" : Integer,
      "Ipv6Addresses" : [ InstanceIpv6Address, ... ],
      "KernelId" : String,
      "KeyName" : String,
      "LaunchTemplate" : LaunchTemplateSpecification,
      "LicenseSpecifications" : [ LicenseSpecification, ... ],
      "MetadataOptions" : MetadataOptions,
      "Monitoring" : Boolean,
      "NetworkInterfaces" : [ NetworkInterface, ... ],
      "PlacementGroupName" : String,
      "PrivateDnsNameOptions" : PrivateDnsNameOptions,
      "PrivateIpAddress" : String,
      "PropagateTagsToVolumeOnCreation" : Boolean,
      "RamdiskId" : String,
      "SecurityGroupIds" : [ String, ... ],
      "SecurityGroups" : [ String, ... ],
      "SourceDestCheck" : Boolean,
      "SsmAssociations" : [ SsmAssociation, ... ],
      "SubnetId" : String,
      "Tags" : [ Tag, ... ],
      "Tenancy" : String,
      "UserData" : String,
      "Volumes" : [ Volume, ... ]
    }
}
\`\`\`

### YAML

\`\`\`
Type: AWS::EC2::Instance
Properties:
  AdditionalInfo: String
  Affinity: String
  AvailabilityZone: String
  BlockDeviceMappings: 
    - BlockDe

[Content truncated for test fixture]`,
    },
  },

  /** Captured 2026-03-22. read_sections on CFN Lambda Function page. Truncated from 28K chars. */
  lambdaRuntime: {
    success: {
      result: `## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::Lambda::Function",
  "Properties" : {
      "Architectures" : [ String, ... ],
      "CapacityProviderConfig" : CapacityProviderConfig,
      "Code" : Code,
      "CodeSigningConfigArn" : String,
      "DeadLetterConfig" : DeadLetterConfig,
      "Description" : String,
      "DurableConfig" : DurableConfig,
      "Environment" : Environment,
      "EphemeralStorage" : EphemeralStorage,
      "FileSystemConfigs" : [ FileSystemConfig, ... ],
      "FunctionName" : String,
      "FunctionScalingConfig" : FunctionScalingConfig,
      "Handler" : String,
      "ImageConfig" : ImageConfig,
      "KmsKeyArn" : String,
      "Layers" : [ String, ... ],
      "LoggingConfig" : LoggingConfig,
      "MemorySize" : Integer,
      "PackageType" : String,
      "PublishToLatestPublished" : Boolean,
      "RecursiveLoop" : String,
      "ReservedConcurrentExecutions" : Integer,
      "Role" : String,
      "Runtime" : String,
      "RuntimeManagementConfig" : RuntimeManagementConfig,
      "SnapStart" : SnapStart,
      "Tags" : [ Tag, ... ],
      "TenancyConfig" : TenancyConfig,
      "Timeout" : Integer,
      "TracingConfig" : TracingConfig,
      "VpcConfig" : VpcConfig
    }
}
\`\`\`

### YAML

\`\`\`
Type: AWS::Lambda::Function
Properties:
  Architectures: 
    - String
  CapacityProviderConfig: 
    CapacityProviderConfig
  Code: 
    Code
  CodeSigningConfigArn: String
  DeadLetterConfig: 
    DeadLetterConfig
  Description: String
  DurableConfig: 
    DurableConfig
  Environment: 
    Environment
  EphemeralStorage: 
    EphemeralStorage
  FileSystemConfigs: 
    - FileSystemConfig
  FunctionName: String
  FunctionScalingConfig: 
    FunctionScalingConfig
  Handler: String
  ImageConfig: 
    ImageConfig
  KmsKeyArn: String
  Layers: 
    - String
  LoggingConfig: 
    LoggingConfig
  MemorySize: Integer
  PackageType: String
  PublishToLatestPublish

[Content truncated for test fixture]`,
    },
  },

  /** Captured 2026-03-22. read_sections on CFN RDS DBInstance page. Truncated from 97K chars. */
  rdsEngine: {
    success: {
      result: `## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::RDS::DBInstance",
  "Properties" : {
      "AdditionalStorageVolumes" : [ AdditionalStorageVolume, ... ],
      "AllocatedStorage" : String,
      "AllowMajorVersionUpgrade" : Boolean,
      "ApplyImmediately" : Boolean,
      "AssociatedRoles" : [ DBInstanceRole, ... ],
      "AutomaticBackupReplicationKmsKeyId" : String,
      "AutomaticBackupReplicationRegion" : String,
      "AutomaticBackupReplicationRetentionPeriod" : Integer,
      "AutoMinorVersionUpgrade" : Boolean,
      "AvailabilityZone" : String,
      "BackupRetentionPeriod" : Integer,
      "BackupTarget" : String,
      "CACertificateIdentifier" : String,
      "CertificateRotationRestart" : Boolean,
      "CharacterSetName" : String,
      "CopyTagsToSnapshot" : Boolean,
      "CustomIAMInstanceProfile" : String,
      "DatabaseInsightsMode" : String,
      "DBClusterIdentifier" : String,
      "DBClusterSnapshotIdentifier" : String,
      "DBInstanceClass" : String,
      "DBInstanceIdentifier" : String,
      "DBName" : String,
      "DBParameterGroupName" : String,
      "DBSecurityGroups" : [ String, ... ],
      "DBSnapshotIdentifier" : String,
      "DBSubnetGroupName" : String,
      "DBSystemId" : String,
      "DedicatedLogVolume" : Boolean,
      "DeleteAutomatedBackups" : Boolean,
      "DeletionProtection" : Boolean,
      "Domain" : String,
      "DomainAuthSecretArn" : String,
      "DomainDnsIps" : [ String, ... ],
      "DomainFqdn" : String,
      "DomainIAMRoleName" : String,
      "DomainOu" : String,
      "EnableCloudwatchLogsExports" : [ String, ... ],
      "EnableIAMDatabaseAuthentication" : Boolean,
      "EnablePerformanceInsights" : Boolean,
      "Engine" : String,
      "EngineLifecycleSupport" : String,
      "EngineVersion" : String,
      "Iops" : Integer,
      "KmsKeyId" : String,
      "LicenseModel" : String,
      "ManageMasterUserPasswor

[Content truncated for test fixture]`,
    },
  },

  /** Captured 2026-03-22. read_sections on CFN DynamoDB Table page. Truncated from 20K chars. */
  dynamoDbBillingMode: {
    success: {
      result: `## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::DynamoDB::Table",
  "Properties" : {
      "AttributeDefinitions" : [ AttributeDefinition, ... ],
      "BillingMode" : String,
      "ContributorInsightsSpecification" : ContributorInsightsSpecification,
      "DeletionProtectionEnabled" : Boolean,
      "GlobalSecondaryIndexes" : [ GlobalSecondaryIndex, ... ],
      "ImportSourceSpecification" : ImportSourceSpecification,
      "KeySchema" : [ KeySchema, ... ],
      "KinesisStreamSpecification" : KinesisStreamSpecification,
      "LocalSecondaryIndexes" : [ LocalSecondaryIndex, ... ],
      "OnDemandThroughput" : OnDemandThroughput,
      "PointInTimeRecoverySpecification" : PointInTimeRecoverySpecification,
      "ProvisionedThroughput" : ProvisionedThroughput,
      "ResourcePolicy" : ResourcePolicy,
      "SSESpecification" : SSESpecification,
      "StreamSpecification" : StreamSpecification,
      "TableClass" : String,
      "TableName" : String,
      "Tags" : [ Tag, ... ],
      "TimeToLiveSpecification" : TimeToLiveSpecification,
      "WarmThroughput" : WarmThroughput
    }
}
\`\`\`

### YAML

\`\`\`
Type: AWS::DynamoDB::Table
Properties:
  AttributeDefinitions: 
    - AttributeDefinition
  BillingMode: String
  ContributorInsightsSpecification: 
    ContributorInsightsSpecification
  DeletionProtectionEnabled: Boolean
  GlobalSecondaryIndexes: 
    - GlobalSecondaryIndex
  ImportSourceSpecification: 
    ImportSourceSpecification
  KeySchema: 
    - KeySchema
  KinesisStreamSpecification: 
    KinesisStreamSpecification
  LocalSecondaryIndexes: 
    - LocalSecondaryIndex
  OnDemandThroughput: 
    OnDemandThroughput
  PointInTimeRecoverySpecification: 
    PointInTimeRecoverySpecification
  ProvisionedThroughput: 
    ProvisionedThroughput
  ResourcePolicy: 
    ResourcePolicy
  SSESpecification: 
    SSESpecification
  StreamSpecification: 
    StreamSpecification
  TableClass: Stri

[Content truncated for test fixture]`,
    },
  },

  /** Synthetic: very long content — stress test for truncation/synthesis. */
  longContent: {
    success: {
      result:
        "## Overview\n\n" +
        "This is a very long documentation page that covers many aspects of the resource configuration. ".repeat(
          50,
        ) +
        "\n\n## Properties\n\n" +
        "PropertyA: Description of property A.\n" +
        "PropertyB: Description of property B.\n" +
        "PropertyC: Description of property C.\n",
    },
  },

  /** Synthetic: response with "Note: not found" pattern — stripped by display.ts regex. */
  withNotFoundNote: {
    success: {
      result:
        "> **Note**: Section 'Syntax' not found in the document.\n\n" +
        "## Properties\n\n" +
        "**BucketName**\n" +
        "A name for the bucket.",
    },
  },

  /** Synthetic: no matching sections error — triggers fallback to read_documentation. */
  noMatchingSections: {
    error: new Error("No matching sections were found"),
  },

  /** Synthetic: generic server error. */
  serverError: {
    error: new Error(
      "Internal server error: documentation service unavailable",
    ),
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 5. aws-documentation-mcp-server — read_documentation (full page fallback)
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docReadFullResponses = {
  /** Captured 2026-03-22 from aws-documentation-mcp-server read_documentation. Full S3 Bucket page, truncated from 5K chars. */
  s3BucketFull: {
    success: {
      result: `AWS Documentation from https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html:

This is the new *CloudFormation Template Reference Guide*.
Please update your bookmarks and links. For help getting started with CloudFormation, see the
[AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html").

# AWS::S3::Bucket

The \`AWS::S3::Bucket\` resource creates an Amazon S3 bucket in the same AWS Region where you create the AWS CloudFormation stack.

To control how AWS CloudFormation handles the bucket when the stack is
deleted, you can set a deletion policy for your bucket. You can choose to
*retain* the bucket or to *delete* the bucket. For
more information, see [DeletionPolicy
Attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html").

###### Important

You can only delete empty buckets. Deletion fails for buckets that have contents.

## Syntax

To declare this entity in your CloudFormation template, use the following syntax:

### JSON

\`\`\`
{
  "Type" : "AWS::S3::Bucket",
  "Properties" : {
      "AbacStatus" : String,
      "AccelerateConfiguration" : AccelerateConfiguration,
      "AccessControl" : String,
      "AnalyticsConfigurations" : [ AnalyticsConfiguration, ... ],
      "BucketEncryption" : BucketEncryption,
      "BucketName" : String,
      "BucketNamePrefix" : String,
      "BucketNamespace" : String,
      "CorsConfiguration" : CorsConfiguration,
      "IntelligentTieringConfigurations" : [ IntelligentTieringConfiguration, ... ],
      "InventoryConfigurations" : [ InventoryConfiguration, ... ],
      "LifecycleConfiguration" : LifecycleConfiguration,
      "LoggingConfiguration" : LoggingConfiguration,
      "MetadataConfiguration" : MetadataConfiguration,
      "MetadataTableConfiguration" : MetadataTableConfiguration,
      "MetricsConfigurations" : [ MetricsConfiguration, ... ],
      "NotificationConfiguration" : NotificationConfiguration,
      "ObjectLockConfiguration" : ObjectLockConfiguration,
      "ObjectLockEnabled" : Boolean,
      "OwnershipControls" : OwnershipControls,
      "PublicAccessBlockConfiguration" : PublicAccessBlockConfiguration,
      "ReplicationConfiguration" : ReplicationConfiguration,
      "Tags" : [ Tag, ... ],
      "VersioningConfiguration" : VersioningConfiguration,
      "WebsiteConfiguration" : WebsiteConfiguration
    }
}
\`\`\`

### YAML

\`\`\`
Type: AWS::S3::Bucket
Properties:
  AbacStatus: String
  AccelerateConfiguration: 
    AccelerateConfiguration
  AccessControl: String
  AnalyticsConfigurations: 
    - AnalyticsConfiguration
  BucketEncryption: 
    BucketEncryption
  BucketName: String
  BucketNamePrefix: String
  BucketNamespace: String
  CorsConfiguration: 
    CorsConfiguration
  Inte

[Content truncated for test fixture]`,
    },
  },

  /** Captured 2026-03-22. Full Lambda Function page, truncated from 5K chars. */
  lambdaFunctionFull: {
    success: {
      result: `AWS Documentation from https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html:

This is the new *CloudFormation Template Reference Guide*.
Please update your bookmarks and links. For help getting started with CloudFormation, see the
[AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html").

# AWS::Lambda::Function

The \`AWS::Lambda::Function\` resource creates a Lambda function. To create a function, you need a
[deployment package](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html "https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html") and an
[execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html "https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html").
The deployment package is a .zip file archive or container image that contains your function code.
The execution role grants the function permission to use AWS services, such as Amazon CloudWatch Logs
for log streaming and AWS X-Ray for request tracing.

You set the package type to \`Image\` if the deployment package is a
[container image](https://docs.aws.amazon.com/lambda/latest/dg/lambda-images.html "https://docs.aws.amazon.com/lambda/latest/dg/lambda-images.html"). For these functions,
include the URI of the container image in the Amazon ECR registry in the [\`ImageUri\` property of the \`Code\` property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-imageuri "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-imageuri"). You do not need to specify the handler and
runtime properties.

You set the package type to \`Zip\` if the deployment package is a [.zip file archive](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html#gettingstarted-package-zip "https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html#gettingstarted-package-zip").
For these functions, specify the Amazon S3 location of your .zip file in the \`Code\` property.
Alternatively, for Node.js and Python functions, you can define your function inline in the [\`ZipFile\` property of the \`Code\` property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-zipfile "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-zipfile"). In both cases, you must also specify the
handler and runtime properties.

You can use [code signing](https://docs.aws.amazon.com/lambda/latest/dg/configuration-codesigning.html "https://docs.aws.amazon.com/lambda/latest/dg/configuration-codesigning.html")
if your deployment package is a .zip file archive. T

[Content truncated for test fixture]`,
    },
  },

  /** Synthetic: empty page — edge case. */
  emptyPage: {
    success: { result: "" },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 5. iam-mcp-server — simulate_principal_policy
//    Captured 2026-03-22 via: uvx awslabs.iam-mcp-server@latest --readonly
//    Real server wraps payload in { result: {...} } envelope (same as WA Security).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps a payload in the { result: {...} } envelope that the real
 * iam-mcp-server returns for simulate_principal_policy.
 */
function iamResultEnvelope(payload: Record<string, unknown>): {
  result: Record<string, unknown>;
} {
  return {
    result: {
      ...payload,
      IsTruncated: false,
      PolicySourceArn: "arn:aws:iam::054125018476:user/assignee-operator",
    },
  };
}

const iamResponses = {
  /** Captured 2026-03-22. All S3 bucket creation actions allowed. */
  s3BucketAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "s3:CreateBucket",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonS3FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "s3:PutBucketTagging",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonS3FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** Captured 2026-03-22. EC2 instance — ec2:RunInstances and iam:PassRole denied. */
  ec2InstancePartialDeny: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:RunInstances",
            EvalResourceName: "*",
            EvalDecision: "implicitDeny",
            MatchedStatements: [],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:CreateTags",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2TaggingAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "iam:PassRole",
            EvalResourceName: "*",
            EvalDecision: "implicitDeny",
            MatchedStatements: [],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** Captured 2026-03-22. All Lambda function creation actions allowed. */
  lambdaFunctionAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "lambda:CreateFunction",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AWSLambdaFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "lambda:TagResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AWSLambdaFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "iam:PassRole",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "IAMPassRolePolicy",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** SSM Parameter — all actions allowed. Input: { actions: [cloudcontrol:CreateResource, ssm:PutParameter, ssm:AddTagsToResource] } */
  ssmParameterAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ssm:PutParameter",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonSSMFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ssm:AddTagsToResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonSSMFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** SecurityGroup — all creation actions allowed. Input: { actions: [cloudcontrol:CreateResource, ec2:CreateSecurityGroup, ec2:AuthorizeSecurityGroupIngress, ec2:AuthorizeSecurityGroupEgress] } */
  securityGroupAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:CreateSecurityGroup",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:AuthorizeSecurityGroupIngress",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:AuthorizeSecurityGroupEgress",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** VPC — all creation actions allowed. Input: { actions: [cloudcontrol:CreateResource, ec2:CreateVpc, ec2:ModifyVpcAttribute] } */
  vpcAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:CreateVpc",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "ec2:ModifyVpcAttribute",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonEC2FullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** DynamoDB — all creation actions allowed. Input: { actions: [cloudcontrol:CreateResource, dynamodb:CreateTable, dynamodb:TagResource] } */
  dynamoDbTableAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "dynamodb:CreateTable",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonDynamoDBFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "dynamodb:TagResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "AmazonDynamoDBFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },

  /** ELBv2 — all creation actions allowed. Input: { actions: [cloudcontrol:CreateResource, elasticloadbalancing:CreateLoadBalancer] } */
  elbv2LoadBalancerAllowed: {
    success: mcpText(
      iamResultEnvelope({
        EvaluationResults: [
          {
            EvalActionName: "cloudcontrol:CreateResource",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "cloudcontrol:GetResourceRequestStatus",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "CloudControlFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 10, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "elasticloadbalancing:CreateLoadBalancer",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "ElasticLoadBalancingFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
          {
            EvalActionName: "elasticloadbalancing:AddTags",
            EvalResourceName: "*",
            EvalDecision: "allowed",
            MatchedStatements: [
              {
                SourcePolicyId: "ElasticLoadBalancingFullAccess",
                SourcePolicyType: "IAM Policy",
                StartPosition: { Line: 3, Column: 14 },
                EndPosition: { Line: 8, Column: 5 },
              },
            ],
            MissingContextValues: [],
          },
        ],
      }),
    ),
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 6. well-architected-security-mcp-server — GetSecurityFindings (v0.1.7+)
//    Captured 2026-03-22 via: uvx awslabs.well-architected-security-mcp-server@0.1.7
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps a payload in the { result: {...} } envelope that the real
 * well-architected-security-mcp-server v0.1.7 returns.
 */
function securityResultEnvelope(payload: unknown): unknown {
  return { result: payload };
}

const securityPostureResponses = {
  /** Captured 2026-04-10. S3 bucket with CRITICAL + HIGH + MEDIUM findings (v0.1.7 envelope). */
  s3BucketPosture: {
    success: securityResultEnvelope({
      service: "securityhub",
      enabled: true,
      findings: [
        {
          severity: "CRITICAL",
          title: "S3 bucket has public read access",
          recommendation:
            "Block public access by enabling S3 Block Public Access settings at the bucket level. Set BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, and RestrictPublicBuckets to true.",
          service: "SecurityHub",
          controlId: "S3.2",
          complianceStatus: "FAILED",
          resourceArn: "arn:aws:s3:::assignee-test-capture-bucket",
        },
        {
          severity: "HIGH",
          title: "S3 bucket does not have default encryption enabled",
          recommendation:
            "Enable default encryption on the S3 bucket using SSE-S3 (AES-256) or SSE-KMS. Use aws s3api put-bucket-encryption to configure server-side encryption.",
          service: "SecurityHub",
          controlId: "S3.4",
          complianceStatus: "FAILED",
          resourceArn: "arn:aws:s3:::assignee-test-capture-bucket",
        },
        {
          severity: "MEDIUM",
          title: "S3 bucket versioning is not enabled",
          recommendation:
            "Enable versioning on the S3 bucket to preserve, retrieve, and restore every version of every object. Use aws s3api put-bucket-versioning --bucket BUCKET --versioning-configuration Status=Enabled.",
          service: "SecurityHub",
          controlId: "S3.14",
          complianceStatus: "FAILED",
          resourceArn: "arn:aws:s3:::assignee-test-capture-bucket",
        },
      ],
      summary: {
        total: 3,
        critical: 1,
        high: 1,
        medium: 1,
        low: 0,
        informational: 0,
      },
    }),
  },

  /** Captured 2026-04-10. No findings — clean security posture (v0.1.7 envelope). */
  noFindings: {
    success: securityResultEnvelope({
      service: "securityhub",
      enabled: true,
      findings: [],
      summary: {
        total: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        informational: 0,
      },
    }),
  },

  /** Captured 2026-04-10. Security Hub not enabled in region (v0.1.7 envelope). */
  serviceDisabled: {
    success: securityResultEnvelope({
      service: "securityhub",
      enabled: false,
      message:
        "Security Hub is not enabled in us-east-1. Enable it via the AWS console or CLI.",
    }),
  },

  /** Captured 2026-04-10. CheckSecurityServices response (v0.1.7 envelope). */
  checkServicesAllEnabled: {
    success: securityResultEnvelope({
      region: "us-east-1",
      services_checked: ["securityhub"],
      all_enabled: true,
      service_statuses: {
        securityhub: { enabled: true, details: "Security Hub is active" },
      },
    }),
  },

  /** Captured 2026-04-10. CheckSecurityServices — service disabled (v0.1.7 envelope). */
  checkServicesDisabled: {
    success: securityResultEnvelope({
      region: "us-east-1",
      services_checked: ["securityhub"],
      all_enabled: false,
      service_statuses: {
        securityhub: {
          enabled: false,
          details: "Security Hub is not enabled in this region",
        },
      },
    }),
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 8. billing-cost-management-mcp-server@0.0.17 — cost-explorer (getCostAndUsage by SERVICE)
//    Captured 2026-04-10 via: uvx awslabs.billing-cost-management-mcp-server@0.0.17
//    Response format: session-based { status, data: { preview: [{key,value}] } }
//    Note: RESOURCE_ID filter removed — now uses SERVICE dimension grouping.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a session-based billing response matching the 0.0.17+ MCP server format.
 * The server returns { status, data: { ..., preview: [{key, value}] } } where
 * ResultsByTime is a JSON-stringified value in the preview array.
 */
function billingSessionResponse(resultsByTime: unknown[]): {
  status: string;
  data: {
    status: string;
    data_stored: boolean;
    table_name: string;
    schema: string[];
    preview: Array<{ key: string; value: string }>;
  };
} {
  return {
    status: "success",
    data: {
      status: "success",
      data_stored: true,
      table_name: "getCostAndUsage_mock",
      schema: ["key", "value"],
      preview: [
        {
          key: "ResultsByTime",
          value: JSON.stringify(resultsByTime),
        },
      ],
    },
  };
}

const billingResponses = {
  /** Captured 2026-04-10 from billing-cost-management-mcp-server@0.0.17. S3 service cost for current month. */
  s3BucketCost: {
    success: billingSessionResponse([
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["Amazon Simple Storage Service"],
            Metrics: {
              UnblendedCost: { Amount: "0.023", Unit: "USD" },
            },
          },
        ],
        Total: {},
        Estimated: true,
      },
    ]),
  },
  /** Captured 2026-04-10. Multiple services (S3 + Lambda) cost data grouped by SERVICE. */
  multiResourceCost: {
    success: billingSessionResponse([
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["Amazon Simple Storage Service"],
            Metrics: {
              UnblendedCost: { Amount: "0.023", Unit: "USD" },
            },
          },
          {
            Keys: ["AWS Lambda"],
            Metrics: {
              UnblendedCost: { Amount: "1.47", Unit: "USD" },
            },
          },
        ],
        Total: {},
        Estimated: true,
      },
    ]),
  },
  /** Captured 2026-04-10. Empty response — no cost data for the queried services. */
  noCostData: {
    success: billingSessionResponse([
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [],
        Total: {},
        Estimated: true,
      },
    ]),
  },
  /** Captured 2026-04-10. Cost forecast (still uses mcpText format — getCostForecast operation). */
  costForecast: {
    success: mcpText({
      Total: {
        Amount: "3.50",
        Unit: "USD",
      },
      ForecastResultsByTime: [
        {
          TimePeriod: { Start: "2026-04-10", End: "2026-05-01" },
          MeanValue: "3.50",
          PredictionIntervalLowerBound: "2.80",
          PredictionIntervalUpperBound: "4.20",
        },
      ],
    }),
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Exported namespace
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// Raw schema objects — for mocking CloudFormationSchemaService.getSchema()
// ═══════════════════════════════════════════════════════════════════════════════

function unwrapSchemaPayload(response: {
  type: "text";
  text: string;
}): Record<string, unknown> {
  return JSON.parse(response.text) as Record<string, unknown>;
}

/** Raw schema objects keyed by resource nickname (pre-adapter format). */
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

/** Maps AWS resource type names to raw schema objects for mockGetSchema. */
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

// ═══════════════════════════════════════════════════════════════════════════════
// Mock tool factory functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a mock StructuredTool that returns the given response on invoke().
 * Matches the pattern used across all existing tests in the project.
 *
 * @param name  - Tool name from ToolName constants
 * @param response - The value to resolve (or Error to reject) on invoke
 *
 * @example
 *   const tool = createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success);
 *   const result = await tool.invoke({ service_code: "AmazonS3" });
 */
export function createMockTool(
  name: string,
  response: unknown,
): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockResolvedValue(response),
  } as unknown as StructuredTool;
}

/**
 * Creates a mock tool that rejects with the given error.
 *
 * @example
 *   const tool = createFailingMockTool(ToolName.GET_PRICING, new Error("Server down"));
 */
export function createFailingMockTool(
  name: string,
  error: Error = new Error("Tool execution failed"),
): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockRejectedValue(error),
  } as unknown as StructuredTool;
}

/**
 * Creates a mock tool that never resolves (hangs forever) — for timeout tests.
 *
 * @example
 *   const tool = createHangingMockTool(ToolName.GET_PRICING);
 */
export function createHangingMockTool(name: string): StructuredTool {
  return {
    name,
    description: "",
    // vi.fn(impl) keeps spy semantics for assertions; impl bound at
    // construction so the hang survives within a test.
    invoke: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as StructuredTool;
}

/**
 * Creates a mock tool that resolves after a specified delay.
 *
 * @example
 *   const tool = createDelayedMockTool(ToolName.GET_PRICING, McpMocks.pricing.ec2T3Micro.success, 5000);
 */
export function createDelayedMockTool(
  name: string,
  response: unknown,
  delayMs: number,
): StructuredTool {
  return {
    name,
    description: "",
    // vi.fn(impl) preserves spy semantics for assertions; impl bound at
    // construction so it survives within a test.
    invoke: vi.fn(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(response), delayMs)),
    ),
  } as unknown as StructuredTool;
}

/**
 * Creates a mock tool that returns null — simulates timeout via withTimeout().
 *
 * @example
 *   const tool = createNullMockTool(ToolName.SEARCH_DOCUMENTATION);
 */
export function createNullMockTool(name: string): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockResolvedValue(null),
  } as unknown as StructuredTool;
}

/**
 * Creates a mock tool that returns different responses on successive calls.
 *
 * @example
 *   const tool = createSequenceMockTool(ToolName.GET_PRICING, [
 *     McpMocks.pricing.ec2T3Micro.success,
 *     McpMocks.pricing.ec2T3Small.success,
 *   ]);
 */
export function createSequenceMockTool(
  name: string,
  responses: unknown[],
): StructuredTool {
  const mockFn = vi.fn();
  responses.forEach((response) => {
    if (response instanceof Error) {
      mockFn.mockRejectedValueOnce(response);
    } else {
      mockFn.mockResolvedValueOnce(response);
    }
  });
  return {
    name,
    description: "",
    invoke: mockFn,
  } as unknown as StructuredTool;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pre-built tool sets — common combinations used across multiple test files
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a mock IAM simulate_principal_policy tool with a captured response.
 *
 * @example
 *   const tool = createIamMockTool(McpMocks.iam.ec2InstancePartialDeny.success);
 */
export function createIamMockTool(
  response = McpMocks.iam.s3BucketAllowed.success,
): StructuredTool {
  return createMockTool(ToolName.SIMULATE_PRINCIPAL_POLICY, response);
}

/**
 * Creates a mock GetSecurityFindings tool with a captured response.
 *
 * @example
 *   const tool = createSecurityMockTool(McpMocks.security.s3BucketPosture.success);
 */
export function createSecurityMockTool(
  response = McpMocks.security.noFindings.success,
): StructuredTool {
  return createMockTool(ToolName.GET_SECURITY_FINDINGS, response);
}

/**
 * Creates a mock cost-explorer tool with a captured response.
 *
 * @example
 *   const tool = createBillingMockTool(McpMocks.billing.s3BucketCost.success);
 */
export function createBillingMockTool(
  response = McpMocks.billing.s3BucketCost.success,
): StructuredTool {
  return createMockTool(ToolName.COST_EXPLORER, response);
}

/**
 * Creates a complete set of all MCP tools with default success responses.
 * Note: Schema fetching is no longer an MCP tool — mock CloudFormationSchemaService separately.
 */
export function createAllMockTools(): StructuredTool[] {
  return [
    createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success),
    createMockTool(
      ToolName.SEARCH_DOCUMENTATION,
      McpMocks.docSearch.s3BucketName.success,
    ),
    createMockTool(
      ToolName.READ_SECTIONS,
      McpMocks.docReadSections.s3BucketName.success,
    ),
    createMockTool(
      ToolName.READ_DOCUMENTATION,
      McpMocks.docReadFull.s3BucketFull.success,
    ),
    createMockTool(
      ToolName.SIMULATE_PRINCIPAL_POLICY,
      McpMocks.iam.s3BucketAllowed.success,
    ),
    createMockTool(
      ToolName.GET_SECURITY_FINDINGS,
      McpMocks.security.noFindings.success,
    ),
    createMockTool(
      ToolName.COST_EXPLORER,
      McpMocks.billing.s3BucketCost.success,
    ),
  ];
}

/**
 * Creates a pricing-only tool set.
 * Schema fetching is now handled by CloudFormationSchemaService (not MCP).
 */
export function createPricingMockTools(
  pricingResponse = McpMocks.pricing.s3Storage.success,
): StructuredTool[] {
  return [createMockTool(ToolName.GET_PRICING, pricingResponse)];
}

/**
 * @deprecated Use createPricingMockTools() instead.
 * Schema fetching is no longer MCP-based. Schema arg is ignored.
 */
export function createCoreMockTools(
  _schemaResponse?: unknown,
  pricingResponse = McpMocks.pricing.s3Storage.success,
): StructuredTool[] {
  return [createMockTool(ToolName.GET_PRICING, pricingResponse)];
}

/**
 * Creates documentation tools only (search + read_sections + read_documentation).
 * Used by display.ts renderDocHelp tests.
 */
export function createDocMockTools(
  searchResponse: unknown = McpMocks.docSearch.s3BucketName.success,
  readSectionsResponse: unknown = McpMocks.docReadSections.s3BucketName.success,
  readFullResponse: unknown = McpMocks.docReadFull.s3BucketFull.success,
): StructuredTool[] {
  return [
    createMockTool(ToolName.SEARCH_DOCUMENTATION, searchResponse),
    createMockTool(ToolName.READ_SECTIONS, readSectionsResponse),
    createMockTool(ToolName.READ_DOCUMENTATION, readFullResponse),
  ];
}

/**
 * Creates a pricing tool that returns different prices for different instance types.
 * Maps instance type → mock pricing response.
 *
 * @example
 *   const tool = createPricingLookupTool({
 *     "t3.micro": McpMocks.pricing.ec2T3Micro.success,
 *     "t3.small": McpMocks.pricing.ec2T3Small.success,
 *   });
 */
export function createPricingLookupTool(
  priceMap: Record<string, unknown>,
): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    description: "",
    // vi.fn(impl) preserves spy semantics for tests that assert on
    // .toHaveBeenCalledWith. Implementation is bound at construction time;
    // each test creates a fresh tool so mockReset between tests is fine.
    invoke: vi.fn(
      async (args: { filters?: Array<{ Field: string; Value: string }> }) => {
        const instanceFilter = args.filters?.find(
          (f) => f.Field === "instanceType",
        );
        if (instanceFilter && instanceFilter.Value in priceMap) {
          return priceMap[instanceFilter.Value];
        }
        return McpMocks.pricing.emptyData.success;
      },
    ),
  } as unknown as StructuredTool;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Filter-dispatched pricing tools — match responses by filter fields
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generic filter-dispatched pricing tool factory.
 * Takes a dispatch map where each key encodes filter field=value pairs
 * (separated by `+`) and returns the matching response.
 *
 * Matching logic: ALL filter pairs in a dispatch key must be present in the
 * tool invocation's `filters` array for that entry to match. First match wins.
 *
 * @param dispatchMap - Record of `"field1=value1+field2=value2"` → response
 * @returns A mock StructuredTool that dispatches by filter matching
 *
 * @example
 *   const tool = createServicePricingDispatchTool({
 *     "productFamily=Storage+usagetype=TimedStorage-ByteHrs": McpMocks.pricing.s3Storage.success,
 *     "productFamily=API Request+usagetype=Requests-Tier1": McpMocks.pricing.s3PutRequests.success,
 *   });
 */
export function createServicePricingDispatchTool(
  dispatchMap: Record<string, unknown>,
): StructuredTool {
  // Pre-parse keys into arrays of { Field, Value } for efficient matching
  const parsedEntries = Object.entries(dispatchMap).map(([key, response]) => {
    const conditions = key.split("+").map((pair) => {
      const eqIdx = pair.indexOf("=");
      return { Field: pair.slice(0, eqIdx), Value: pair.slice(eqIdx + 1) };
    });
    return { conditions, response };
  });

  return {
    name: ToolName.GET_PRICING,
    description: "",
    // vi.fn(impl): the implementation is bound at construction time so the
    // tool keeps spy semantics (.toHaveBeenCalledWith etc.). Each test
    // creates a fresh tool via this factory, so vitest mockReset only
    // wipes between tests — within a test the implementation persists.
    invoke: vi.fn(
      async (args: {
        filters?: Array<{ Field: string; Value: string }>;
        service_code?: string;
      }) => {
        const filters = args.filters ?? [];

        for (const entry of parsedEntries) {
          const allMatch = entry.conditions.every((cond) =>
            filters.some(
              (f) => f.Field === cond.Field && f.Value === cond.Value,
            ),
          );
          if (allMatch) {
            return entry.response;
          }
        }

        return McpMocks.pricing.emptyData.success;
      },
    ),
  } as unknown as StructuredTool;
}

/**
 * Creates an S3-specific pricing dispatch tool that routes queries by
 * productFamily + usagetype filters to the correct S3 mock response.
 *
 * Dispatches:
 *  - productFamily=Storage + usagetype=TimedStorage-ByteHrs → s3Storage
 *  - productFamily=API Request + usagetype=Requests-Tier1   → s3PutRequests
 *  - productFamily=API Request + usagetype=Requests-Tier2   → s3GetRequests
 *  - productFamily=Data Transfer                            → s3DataTransfer
 *  - (anything else)                                        → emptyData
 *
 * @example
 *   const tool = createS3PricingDispatchTool();
 *   const storageResult = await tool.invoke({
 *     service_code: "AmazonS3",
 *     filters: [
 *       { Field: "productFamily", Value: "Storage" },
 *       { Field: "usagetype", Value: "TimedStorage-ByteHrs" },
 *     ],
 *   });
 */
export function createS3PricingDispatchTool(): StructuredTool {
  return createServicePricingDispatchTool({
    "productFamily=Storage+usagetype=TimedStorage-ByteHrs":
      McpMocks.pricing.s3Storage.success,
    "productFamily=API Request+usagetype=Requests-Tier1":
      McpMocks.pricing.s3PutRequests.success,
    "productFamily=API Request+usagetype=Requests-Tier2":
      McpMocks.pricing.s3GetRequests.success,
    "productFamily=Data Transfer": McpMocks.pricing.s3DataTransfer.success,
  });
}

/**
 * Creates an EC2-specific pricing dispatch tool that routes queries by
 * productFamily filters to the correct EC2 mock response.
 *
 * Dispatches:
 *  - productFamily=Compute Instance + instanceType=t3.micro → ec2T3Micro
 *  - productFamily=Storage + volumeApiName=gp3              → ebsGp3Storage
 *  - productFamily=IP Address                               → publicIpv4
 *  - productFamily=Data Transfer                            → dataTransferOut
 *  - (anything else)                                        → emptyData
 */
export function createEc2PricingDispatchTool(
  instanceType = "t3.micro",
  instanceMock = McpMocks.pricing.ec2T3Micro.success,
): StructuredTool {
  return createServicePricingDispatchTool({
    [`productFamily=Compute Instance+instanceType=${instanceType}`]:
      instanceMock,
    "productFamily=Storage+volumeApiName=gp3":
      McpMocks.pricing.ebsGp3Storage.success,
    "productFamily=IP Address": McpMocks.pricing.publicIpv4.success,
    "productFamily=Data Transfer": McpMocks.pricing.dataTransferOut.success,
  });
}

/**
 * Creates an RDS-specific pricing dispatch tool that routes queries by
 * productFamily filters to the correct RDS mock response.
 *
 * Dispatches:
 *  - productFamily=Database Instance → rdsT3MicroPostgres (or custom)
 *  - productFamily=Database Storage  → rdsStorageGp3
 *  - productFamily=Storage Snapshot  → rdsBackupStorage
 *  - (anything else)                 → emptyData
 */
export function createRdsPricingDispatchTool(
  computeMock = McpMocks.pricing.rdsT3MicroPostgres.success,
): StructuredTool {
  return createServicePricingDispatchTool({
    "productFamily=Database Instance": computeMock,
    "productFamily=Database Storage": McpMocks.pricing.rdsStorageGp3.success,
    "productFamily=Storage Snapshot": McpMocks.pricing.rdsBackupStorage.success,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing response builder — for generating custom pricing responses
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a minimal pricing response with a single on-demand price.
 * Matches the helper `makePricingResponse` used in pricing-lookup.test.ts.
 *
 * @param priceUsd - The USD price per unit (0 for free-tier)
 * @returns MCP-wrapped pricing response
 *
 * @example
 *   const response = buildPricingResponse(0.0104);
 *   // → { type: "text", text: '{"data":[{"terms":{"OnDemand":...}}]}' }
 */
export function buildPricingResponse(priceUsd: number) {
  return mcpText({
    data: [
      {
        terms: {
          OnDemand: {
            "TERM-1": {
              priceDimensions: {
                "DIM-1": {
                  beginRange: "0",
                  pricePerUnit: { USD: String(priceUsd) },
                },
              },
            },
          },
        },
      },
    ],
  });
}

/**
 * Builds a multi-tier pricing response (e.g., S3 storage tiers).
 *
 * @param tiers - Array of [beginRange, endRange, priceUsd] tuples
 *
 * @example
 *   const response = buildMultiTierPricingResponse([
 *     ["0", "51200", 0.023],
 *     ["51200", "512000", 0.022],
 *     ["512000", "Inf", 0.021],
 *   ]);
 */
export function buildMultiTierPricingResponse(
  tiers: Array<[string, string, number]>,
) {
  const priceDimensions: Record<string, unknown> = {};
  tiers.forEach(([beginRange, endRange, priceUsd], i) => {
    priceDimensions[`DIM-${i}`] = {
      beginRange,
      endRange,
      pricePerUnit: { USD: String(priceUsd) },
    };
  });

  return mcpText({
    data: [
      {
        terms: {
          OnDemand: {
            "TERM-MULTI": { priceDimensions },
          },
        },
      },
    ],
  });
}

/**
 * Builds a schema response for any resource type with custom properties.
 *
 * @example
 *   const response = buildSchemaResponse("AWS::SQS::Queue", {
 *     QueueName: { Type: "string" },
 *     FifoQueue: { Type: "boolean" },
 *   }, ["QueueName"]);
 */
export function buildSchemaResponse(
  typeName: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return mcpText({
    typeName,
    properties,
    required,
  });
}

/**
 * Builds a documentation search response with custom URLs.
 *
 * @example
 *   const response = buildDocSearchResponse([
 *     "https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-naming.html",
 *   ]);
 */
export function buildDocSearchResponse(urls: string[]) {
  return {
    structuredContent: {
      search_results: urls.map((url) => ({ url })),
    },
  };
}

/**
 * Builds a documentation read response with custom text content.
 *
 * @example
 *   const response = buildDocReadResponse("## Properties\n\nBucketName: ...");
 */
export function buildDocReadResponse(content: string) {
  return mcpText(content);
}
