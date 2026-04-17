/**
 * Barrel for shared AWS SDK primitives (factories + lifecycle helpers).
 *
 * Story 50-4 Wave 5.1: added CloudControlAdapter so the in-core graph can
 * construct it without reaching back into the CLI app.
 */

export { createEC2Client } from "./ec2-client-factory.js";
export type { EC2Client, EC2ClientConfig } from "./ec2-client-factory.js";
export { CloudControlAdapter } from "./cloudcontrol-adapter.js";
