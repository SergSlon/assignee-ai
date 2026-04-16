/**
 * Barrel for shared AWS SDK primitives (factories + lifecycle helpers).
 */

export { createEC2Client } from "./ec2-client-factory.js";
export type { EC2Client, EC2ClientConfig } from "./ec2-client-factory.js";
