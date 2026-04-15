/**
 * Facade for the AWS::Lambda::Function plugin. Implementation is split
 * across `./lambda-function/` for SRP — see fields.ts (field defs),
 * runtimes.ts (runtime catalog + sorting/hints + LAMBDA_USD_PER_GB_SECOND
 * fallback rate), env-vars.ts (reserved env var detection + validator/emitter),
 * config.ts (defaults + companion LogGroup + configHints), and index.ts
 * (plugin assembly).
 *
 * Re-exports preserve all consumer import paths (`./lambda-function.js`)
 * including `LAMBDA_USD_PER_GB_SECOND` used by `pricing/strategies/lambda.ts`
 * and `checkLambdaEnvVarKey` / `sortedRuntimes` used by tests.
 */
export {
  lambdaFunctionPlugin,
  LAMBDA_USD_PER_GB_SECOND,
  sortedRuntimes,
  LAMBDA_RESERVED_PREFIXES,
  LAMBDA_RESERVED_EXACT,
  checkLambdaEnvVarKey,
} from "./lambda-function/index.js";
