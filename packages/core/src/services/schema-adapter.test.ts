/**
 * Tests for the Schema Adapter Layer (Story 31.2).
 *
 * Verifies that `adaptDescribeTypeToMcpFormat()` produces output matching
 * the raw DescribeType API output format.
 *
 * Test data mirrors the captured MCP responses in:
 *   apps/cli/src/test-fixtures/mcp-mock-responses.ts
 */

import { describe, it, expect } from "vitest";
import {
  adaptDescribeTypeToMcpFormat,
  type AdaptedSchema,
} from "./schema-adapter.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────
// These simulate DescribeType API responses.  The DescribeType schema is the
// CloudFormation Resource Provider Schema — the same format the MCP tool returned.
// We include extra fields that DescribeType returns (handlers, tagging, etc.)
// to verify the adapter strips them correctly.

const describeTypeS3Bucket: Record<string, unknown> = {
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
  // Extra fields from DescribeType that MCP tool did NOT return:
  handlers: {
    create: { permissions: ["s3:CreateBucket", "s3:PutBucketTagging"] },
    read: { permissions: ["s3:GetBucketTagging"] },
    delete: { permissions: ["s3:DeleteBucket"] },
  },
  tagging: {
    taggable: true,
    tagOnCreate: true,
    tagUpdatable: true,
    cloudFormationSystemTags: true,
    tagProperty: "/properties/Tags",
  },
  sourceUrl:
    "https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-s3.git",
};

const expectedS3Bucket: AdaptedSchema = {
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
};

const describeTypeEc2Instance: Record<string, unknown> = {
  typeName: "AWS::EC2::Instance",
  description: "Resource Type definition for AWS::EC2::Instance",
  properties: {
    Tags: {
      type: "array",
      description: "The tags to add to the instance.",
      insertionOrder: false,
      items: { $ref: "#/definitions/Tag" },
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
      items: { type: "string" },
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
      items: { $ref: "#/definitions/BlockDeviceMapping" },
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
  // Extra DescribeType fields
  handlers: {
    create: { permissions: ["ec2:RunInstances"] },
  },
  tagging: { taggable: true },
};

const expectedEc2Instance: AdaptedSchema = {
  typeName: "AWS::EC2::Instance",
  description: "Resource Type definition for AWS::EC2::Instance",
  properties: {
    Tags: {
      type: "array",
      description: "The tags to add to the instance.",
      insertionOrder: false,
      items: { $ref: "#/definitions/Tag" },
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
      items: { type: "string" },
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
      items: { $ref: "#/definitions/BlockDeviceMapping" },
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
};

const describeTypeLambdaFunction: Record<string, unknown> = {
  typeName: "AWS::Lambda::Function",
  description:
    "The ``AWS::Lambda::Function`` resource creates a Lambda function. To create a function, you need a [deployment package](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html) and an [execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html). The deployment package is a .zip file archive or container image that contains your function code. The execution role grants the function permission to use AWS services, such as Amazon CloudWatch Logs for log streaming and AWS X-Ray for request tracing.\n You set the package type to ``Image`` if the deployment package is a [container image](https://docs.aws.amazon.com/lambda/latest/dg/lambda-images.html). For these functions, include the URI of the container image in the ECR registry in the [ImageUri property of the Code property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-imageuri). You do not need to specify the handler and runtime properties. \n You set the package type to ``Zip`` if the deployment package is a [.zip file archive](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-package.html#gettingstarted-package-zip). For these functions, specify the S3 location of your .zip file in the ``Code`` property. Alternatively, for Node.js and Python functions, you can define your function inline in the [ZipFile property of the Code property](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html#cfn-lambda-function-code-zipfile). In both cases, you must also specify the handler and runtime properties.\n You can use [code signing](https://docs.aws.amazon.com/lambda/latest/dg/configuration-codesigning.html) if your deployment package is a .zip file archive. To enable code signing for this function, specify the ARN of a code-signing configuration. When a user attempts to deploy a code package with ``UpdateFunctionCode``, Lambda checks that the code package has a valid signature from a trusted publisher. The code-signing configuration includes a set of signing profiles, which define the trusted publishers for this function.\n When you update a ``AWS::Lambda::Function`` resource, CFNshort calls the [UpdateFunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionConfiguration.html) and [UpdateFunctionCode](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionCode.html)LAM APIs under the hood. Because these calls happen sequentially, and invocations can happen between these calls, your function may encounter errors in the time between the calls. For example, if you remove an environment variable, and the code that references that environment variable in the same CFNshort update, you may see invocation errors related to a missing environment variable. To work around this, you can invoke your function against a version or alias by default, rather than the ``$LATEST`` version.\n Note that you configure [provisioned concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html) on a ``AWS::Lambda::Version`` or a ``AWS::Lambda::Alias``.\n For a complete introduction to Lambda functions, see [What is Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/lambda-welcome.html) in the *Lambda developer guide.*",
  properties: {
    Tags: {
      type: "array",
      description:
        "A list of [tags](https://docs.aws.amazon.com/lambda/latest/dg/tagging.html) to apply to the function.\n  You must have the ``lambda:TagResource``, ``lambda:UntagResource``, and ``lambda:ListTags`` permissions for your [principal](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html) to manage the CFN stack. If you don't have these permissions, there might be unexpected behavior with stack-level tags propagating to the resource during resource creation and update.",
      insertionOrder: false,
      items: { $ref: "#/definitions/Tag" },
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
  // Extra DescribeType fields
  handlers: {
    create: {
      permissions: [
        "lambda:CreateFunction",
        "lambda:GetFunction",
        "lambda:PutFunctionConcurrency",
      ],
    },
  },
  tagging: { taggable: true },
  createOnlyProperties: ["/properties/FunctionName"],
};

const expectedLambdaFunction: AdaptedSchema = {
  typeName: "AWS::Lambda::Function",
  description: expectedLambdaDescription(),
  properties: {
    Tags: {
      type: "array",
      description:
        "A list of [tags](https://docs.aws.amazon.com/lambda/latest/dg/tagging.html) to apply to the function.\n  You must have the ``lambda:TagResource``, ``lambda:UntagResource``, and ``lambda:ListTags`` permissions for your [principal](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html) to manage the CFN stack. If you don't have these permissions, there might be unexpected behavior with stack-level tags propagating to the resource during resource creation and update.",
      insertionOrder: false,
      items: { $ref: "#/definitions/Tag" },
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
  createOnlyProperties: ["/properties/FunctionName"],
};

/** Helper to get the long Lambda description without repeating it inline */
function expectedLambdaDescription(): string {
  return describeTypeLambdaFunction["description"] as string;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("adaptDescribeTypeToMcpFormat", () => {
  describe("format parity with captured MCP responses", () => {
    it("S3 Bucket: output matches MCP format", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      expect(result).toEqual(expectedS3Bucket);
    });

    it("EC2 Instance: output matches MCP format", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeEc2Instance);
      expect(result).toEqual(expectedEc2Instance);
    });

    it("Lambda Function: output matches MCP format", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      expect(result).toEqual(expectedLambdaFunction);
    });
  });

  describe("strips non-pipeline fields", () => {
    it("removes handlers, tagging, sourceUrl from output", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      expect(result).not.toHaveProperty("handlers");
      expect(result).not.toHaveProperty("tagging");
      expect(result).not.toHaveProperty("sourceUrl");
    });
  });

  describe("preserves property metadata", () => {
    it("preserves enum values on AccessControl", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      const accessControl = result.properties["AccessControl"] as Record<
        string,
        unknown
      >;
      expect(accessControl["enum"]).toEqual([
        "AuthenticatedRead",
        "AwsExecRead",
        "BucketOwnerFullControl",
        "BucketOwnerRead",
        "LogDeliveryWrite",
        "Private",
        "PublicRead",
        "PublicReadWrite",
      ]);
    });

    it("preserves pattern constraint on Role", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      const role = result.properties["Role"] as Record<string, unknown>;
      expect(role["pattern"]).toBe(
        "^arn:(aws[a-zA-Z-]*)?:iam::\\d{12}:role/?[a-zA-Z_0-9+=,.@\\-_/]+$",
      );
    });

    it("preserves minLength on FunctionName", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      const fn = result.properties["FunctionName"] as Record<string, unknown>;
      expect(fn["minLength"]).toBe(1);
    });

    it("preserves maxLength on Handler", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      const handler = result.properties["Handler"] as Record<string, unknown>;
      expect(handler["maxLength"]).toBe(128);
    });

    it("preserves $ref references in properties", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      const arn = result.properties["Arn"] as Record<string, unknown>;
      expect(arn["$ref"]).toBe("#/definitions/Arn");
    });

    it("preserves insertionOrder on array properties", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeEc2Instance);
      const tags = result.properties["Tags"] as Record<string, unknown>;
      expect(tags["insertionOrder"]).toBe(false);
    });

    it("preserves minimum constraint on Timeout", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      const timeout = result.properties["Timeout"] as Record<string, unknown>;
      expect(timeout["minimum"]).toBe(1);
    });
  });

  describe("readOnlyProperties JSONPointer paths", () => {
    it("preserves JSONPointer format for readOnlyProperties", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      expect(result.readOnlyProperties).toContain("/properties/Arn");
      expect(result.readOnlyProperties).toContain("/properties/WebsiteURL");
    });

    it("preserves deeply nested JSONPointer paths", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      expect(result.readOnlyProperties).toContain(
        "/properties/MetadataTableConfiguration/S3TablesDestination/TableNamespace",
      );
    });
  });

  describe("edge case: schema with no required fields", () => {
    it("defaults required to empty array when absent", () => {
      const schema: Record<string, unknown> = {
        typeName: "AWS::Custom::Resource",
        description: "A custom resource",
        properties: { Id: { type: "string" } },
        // required is absent
        readOnlyProperties: ["/properties/Id"],
        primaryIdentifier: ["/properties/Id"],
        additionalProperties: false,
      };
      const result = adaptDescribeTypeToMcpFormat(schema);
      expect(result.required).toEqual([]);
    });

    it("defaults required to empty array when null", () => {
      const schema: Record<string, unknown> = {
        typeName: "AWS::Custom::Resource",
        description: "Test",
        properties: {},
        required: null,
        readOnlyProperties: [],
        primaryIdentifier: ["/properties/Id"],
        additionalProperties: false,
      };
      const result = adaptDescribeTypeToMcpFormat(schema);
      expect(result.required).toEqual([]);
    });
  });

  describe("edge case: empty properties", () => {
    it("defaults properties to empty object when absent", () => {
      const schema: Record<string, unknown> = {
        typeName: "AWS::Custom::Empty",
        description: "No properties",
        // properties is absent
      };
      const result = adaptDescribeTypeToMcpFormat(schema);
      expect(result.properties).toEqual({});
    });
  });

  describe("edge case: deeply nested definitions", () => {
    it("preserves definitions with nested $ref chains", () => {
      const schema: Record<string, unknown> = {
        typeName: "AWS::Custom::Nested",
        description: "Nested definitions",
        properties: {
          Config: {
            $ref: "#/definitions/Config",
          },
        },
        definitions: {
          Config: {
            type: "object",
            properties: {
              SubConfig: {
                $ref: "#/definitions/SubConfig",
              },
            },
          },
          SubConfig: {
            type: "object",
            properties: {
              DeepField: {
                $ref: "#/definitions/DeepField",
              },
            },
          },
          DeepField: {
            type: "string",
            description: "A deeply nested field",
            pattern: "^[a-z]+$",
          },
        },
        additionalProperties: false,
      };
      const result = adaptDescribeTypeToMcpFormat(schema);
      // Tier C: dropped redundant toBeDefined() — defs[...] access fails
      // naturally on undefined; assert the actual nested shape instead.
      const defs = result.definitions as Record<string, unknown>;
      expect(defs["Config"]).toBeInstanceOf(Object);
      expect(defs["SubConfig"]).toBeInstanceOf(Object);
      expect(defs["DeepField"]).toEqual({
        type: "string",
        description: "A deeply nested field",
        pattern: "^[a-z]+$",
      });
    });

    it("omits definitions when not present in source", () => {
      const schema: Record<string, unknown> = {
        typeName: "AWS::Custom::NoDefs",
        description: "No definitions",
        properties: { Name: { type: "string" } },
      };
      const result = adaptDescribeTypeToMcpFormat(schema);
      expect(result.definitions).toBeUndefined();
    });
  });

  describe("edge case: missing optional fields", () => {
    it("defaults all absent fields to safe fallbacks", () => {
      const schema: Record<string, unknown> = {};
      const result = adaptDescribeTypeToMcpFormat(schema);
      expect(result.typeName).toBe("");
      expect(result.description).toBe("");
      expect(result.properties).toEqual({});
      expect(result.required).toEqual([]);
      expect(result.readOnlyProperties).toEqual([]);
      expect(result.primaryIdentifier).toEqual([]);
      expect(result.additionalProperties).toBe(false);
      expect(result.definitions).toBeUndefined();
      expect(result.createOnlyProperties).toBeUndefined();
      expect(result.writeOnlyProperties).toBeUndefined();
    });
  });

  describe("createOnlyProperties pass-through", () => {
    it("passes through createOnlyProperties when present", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeLambdaFunction);
      expect(result.createOnlyProperties).toEqual(["/properties/FunctionName"]);
    });

    it("omits createOnlyProperties when absent", () => {
      const result = adaptDescribeTypeToMcpFormat(describeTypeS3Bucket);
      expect(result.createOnlyProperties).toBeUndefined();
    });
  });
});
