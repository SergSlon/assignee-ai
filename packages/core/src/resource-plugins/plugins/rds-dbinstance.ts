/**
 * Facade for the AWS::RDS::DBInstance plugin. Implementation is split
 * across `./rds-dbinstance/` for SRP — see fields.ts (core + engine
 * selector), engine-versions.ts (per-engine EngineVersion selectors with
 * showIf gates), credentials.ts (DB name + master creds),
 * storage.ts (HA + storage + access + tagging), config.ts (defaults +
 * companion SG resolver + configHints), and index.ts (plugin assembly).
 *
 * Re-exports preserve all consumer import paths (`./rds-dbinstance.js`).
 */
export { rdsDbInstancePlugin } from "./rds-dbinstance/index.js";
