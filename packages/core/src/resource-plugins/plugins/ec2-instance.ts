/**
 * Facade for the AWS::EC2::Instance plugin. Implementation is split
 * across `./ec2-instance/` for SRP — see fields.ts (field defs),
 * user-data.ts (base64 classification + encoding), config.ts (defaults +
 * companion SecurityGroup resolver + configHints), and index.ts (plugin
 * assembly).
 *
 * Re-exports preserve all consumer import paths (`./ec2-instance.js`).
 */
export {
  ec2InstancePlugin,
  INSTANCE_CATEGORIES,
  classifyUserData,
  encodeUserData,
} from "./ec2-instance/index.js";
