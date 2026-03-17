import type { ArchitecturePattern } from "../types.js";

export const threeTierWebPattern: ArchitecturePattern = {
  patternId: "three-tier-web",
  displayName: "Three-Tier Web Application",
  keywords: [
    "three tier",
    "3 tier",
    "three-tier",
    "web application with database",
    "alb ec2 rds",
    "load balanced web app",
    "traditional web stack",
  ],
  resourceList: [
    {
      resourceType: "AWS::EC2::SecurityGroup",
      resourceId: "alb-sg",
      displayName: "ALB Security Group",
    },
    {
      resourceType: "AWS::EC2::SecurityGroup",
      resourceId: "app-sg",
      displayName: "Application Security Group",
    },
    {
      resourceType: "AWS::IAM::Role",
      resourceId: "instance-profile-role",
      displayName: "EC2 Instance Profile Role",
    },
    {
      resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      resourceId: "alb",
      displayName: "Application Load Balancer",
    },
    {
      resourceType: "AWS::EC2::Instance",
      resourceId: "ec2-instance",
      displayName: "EC2 Application Instance",
    },
    {
      resourceType: "AWS::RDS::DBInstance",
      resourceId: "rds-instance",
      displayName: "RDS Database Instance",
    },
  ],
  dependencyOrder: [
    ["alb-sg", "app-sg", "instance-profile-role"],
    ["alb", "rds-instance"],
    ["ec2-instance"],
  ],
  defaultOptions: {
    "rds-instance": {
      Engine: "postgres",
      MultiAZ: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
    },
    "ec2-instance": { InstanceType: "t3.micro", HttpTokens: "required" },
    alb: { Type: "application", Scheme: "internet-facing" },
  },
};
