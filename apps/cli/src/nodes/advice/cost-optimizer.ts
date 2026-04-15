/**
 * cost-optimizer — public entry point.
 *
 * Decomposed into `./cost-optimizer/` per-resource concerns
 * (Wave 6e F1). Kept here as a barrel so existing importers
 * (`./advice/cost-optimizer.js`) continue to resolve unchanged.
 */
export {
  type CostOptRecommendation,
  type OptimizationConfidence,
  buildRecommendation,
} from "./cost-optimizer/types.js";
export { analyzeEc2Instance } from "./cost-optimizer/ec2-analyzer.js";
export { analyzeRdsInstance } from "./cost-optimizer/rds-analyzer.js";
export { analyzeLambdaFunction } from "./cost-optimizer/lambda-analyzer.js";
export { analyzeLogsLogGroup } from "./cost-optimizer/logs-analyzer.js";
export { analyzeResource } from "./cost-optimizer/orchestrator.js";
