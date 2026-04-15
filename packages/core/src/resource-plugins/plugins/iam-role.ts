/**
 * Facade for the AWS::IAM::Role plugin. Implementation is split across
 * `./iam-role/` for SRP — see fields.ts (field defs), trust-policy.ts
 * (AssumeRolePolicyDocument parsing + service principal map),
 * config.ts (defaults + configHints), and index.ts (plugin assembly).
 *
 * Re-exports preserve all consumer import paths (`./iam-role.js`).
 */
export { iamRolePlugin } from "./iam-role/index.js";
