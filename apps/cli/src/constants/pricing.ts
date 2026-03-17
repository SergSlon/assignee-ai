/** AWS Pricing API service codes and filter values used by preflight_guard. */

export const PricingServiceCode = {
  S3: "AmazonS3",
  SSM: "AWSSystemsManager",
  EC2: "AmazonEC2",
  RDS: "AmazonRDS",
  LAMBDA: "AWSLambda",
} as const;

export const PricingFilter = {
  Field: {
    PRODUCT_FAMILY: "productFamily",
    USAGE_TYPE: "usagetype",
    INSTANCE_TYPE: "instanceType",
    OPERATING_SYSTEM: "operatingSystem",
    TENANCY: "tenancy",
    CAPACITY_STATUS: "capacitystatus",
    PRE_INSTALLED_SW: "preInstalledSw",
    DATABASE_ENGINE: "databaseEngine",
    DEPLOYMENT_OPTION: "deploymentOption",
    GROUP: "group",
  },
  Value: {
    S3_STORAGE: "Storage",
    S3_USAGE_TYPE: "TimedStorage-ByteHrs",
    SSM_PRODUCT_FAMILY: "AWS Systems Manager",
    EC2_PRODUCT_FAMILY: "Compute Instance",
    EC2_OS_LINUX: "Linux",
    EC2_TENANCY_SHARED: "Shared",
    EC2_CAPACITY_USED: "Used",
    EC2_NO_PREINSTALL: "NA",
    RDS_PRODUCT_FAMILY: "Database Instance",
    RDS_SINGLE_AZ: "Single-AZ",
    // Lambda constants reserved for Story 7.1 plugin-based cost estimation
    LAMBDA_PRODUCT_FAMILY: "Serverless",
    LAMBDA_REQUESTS_GROUP: "AWS-Lambda-Requests",
  },
} as const;

export const PricingUnit = {
  GB_MONTH: "/GB-month",
  PARAM_HOUR: "/param-hour",
  HOUR: "/hour",
  MILLION_REQUESTS: "/million requests",
} as const;

export const PricingScale = {
  ONE: 1,
  MILLION: 1_000_000,
} as const;

export const PricingDefault = {
  EC2_INSTANCE_TYPE: "t3.micro",
  RDS_INSTANCE_CLASS: "db.t3.micro",
  RDS_ENGINE: "mysql",
} as const;
