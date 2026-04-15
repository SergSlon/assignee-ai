/**
 * Facade for the AWS::CloudWatch::Alarm plugin. Implementation is split
 * across `./cloudwatch-alarm/` for SRP — see fields.ts (field defs +
 * shared SNS ARN validator), config.ts (defaults + configHints), and
 * index.ts (plugin assembly).
 *
 * Re-exports preserve all consumer import paths (`./cloudwatch-alarm.js`).
 */
export { cloudWatchAlarmPlugin } from "./cloudwatch-alarm/index.js";
