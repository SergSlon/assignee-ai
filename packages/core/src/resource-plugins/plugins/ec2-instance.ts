import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::EC2::Instance.
 */
export const ec2InstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INSTANCE,
  commonFields: [
    {
      name: "InstanceType",
      question: {
        type: "enum",
        label: "Instance type",
        options: [
          {
            value: "t3.micro",
            label: "t3.micro  (2 vCPU,  1 GiB) — ~$0.0104/hr",
          },
          {
            value: "t3.small",
            label: "t3.small  (2 vCPU,  2 GiB) — ~$0.0208/hr",
          },
          {
            value: "t3.medium",
            label: "t3.medium (2 vCPU,  4 GiB) — ~$0.0416/hr",
          },
          {
            value: "m5.large",
            label: "m5.large  (2 vCPU,  8 GiB) — ~$0.0960/hr",
          },
          {
            value: "m5.xlarge",
            label: "m5.xlarge (4 vCPU, 16 GiB) — ~$0.1920/hr",
          },
        ],
        initialValue: "t3.micro",
      },
    },
    {
      name: "ImageId",
      question: {
        type: "string",
        label: "AMI ID",
        placeholder: "ami-0abcdef1234567890",
      },
    },
    {
      name: "KeyName",
      question: {
        type: "string",
        label: "EC2 Key Pair name (leave blank for SSM access only)",
        placeholder: "my-key-pair",
      },
    },
    {
      name: "SubnetId",
      question: {
        type: "string",
        label: "Subnet ID",
        placeholder: "subnet-0abc1234",
      },
    },
    {
      name: "SecurityGroupIds",
      question: {
        type: "multi",
        label: "Security Group IDs",
        options: [],
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
      },
    },
  ],
  advancedFields: [
    {
      name: "IamInstanceProfile",
      question: {
        type: "string",
        label: "IAM Instance Profile name",
        placeholder: "my-instance-profile",
      },
    },
    {
      name: "UserData",
      question: {
        type: "string",
        label: "User data script (base64)",
        placeholder: "#!/bin/bash\necho hello",
      },
    },
  ],
  defaults: {},
};
