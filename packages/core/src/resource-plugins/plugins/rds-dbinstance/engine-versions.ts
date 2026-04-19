import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  RdsEngineId,
  RDS_ENGINE_VERSION_HINT,
} from "@/config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";

/**
 * Per-engine version selectors. Each one is a separate EngineVersion
 * field gated by a `showIf` on the selected Engine — this lets the
 * wizard present the right version list for whichever engine the user
 * picked on the previous step.
 */
export const engineVersionFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.ENGINE_VERSION,
    question: {
      type: "enum",
      label: "PostgreSQL version",
      hint: RDS_ENGINE_VERSION_HINT,
      options: [
        {
          value: "16",
          label: "PostgreSQL 16",
          fitHint: "Latest, best performance",
          recommended: true,
        },
        { value: "15", label: "PostgreSQL 15", fitHint: "Stable" },
      ],
      showIf: {
        field: CfnKey.ENGINE,
        value: ResourceDefault.RDS_ENGINE_POSTGRES,
      },
      fetcher: "discover-rds-engine-versions",
    },
  },
  {
    name: CfnKey.ENGINE_VERSION,
    question: {
      type: "enum",
      label: "MySQL version",
      hint: RDS_ENGINE_VERSION_HINT,
      options: [
        {
          value: "8.4",
          label: "MySQL 8.4",
          fitHint: "Latest",
          recommended: true,
        },
        { value: "8.0", label: "MySQL 8.0", fitHint: "Stable, widely used" },
      ],
      showIf: { field: CfnKey.ENGINE, value: AwsDefault.RDS_ENGINE_MYSQL },
      fetcher: "discover-rds-engine-versions",
    },
  },
  {
    name: CfnKey.ENGINE_VERSION,
    question: {
      type: "enum",
      label: "MariaDB version",
      hint: RDS_ENGINE_VERSION_HINT,
      options: [
        {
          value: "11.4",
          label: "MariaDB 11.4",
          fitHint: "Latest",
          recommended: true,
        },
        { value: "10.11", label: "MariaDB 10.11", fitHint: "LTS" },
      ],
      showIf: { field: CfnKey.ENGINE, value: "mariadb" },
      fetcher: "discover-rds-engine-versions",
    },
  },
  {
    name: CfnKey.ENGINE_VERSION,
    question: {
      type: "enum",
      label: "Aurora MySQL version",
      hint: "Aurora MySQL is API-compatible with MySQL.",
      options: [
        {
          value: "3.07.1",
          label: "Aurora MySQL 3.07.1 (MySQL 8.0 compatible)",
          recommended: true,
        },
        { value: "3.05.2", label: "Aurora MySQL 3.05.2 (stable)" },
      ],
      showIf: { field: CfnKey.ENGINE, value: RdsEngineId.AURORA_MYSQL },
      fetcher: "discover-rds-engine-versions",
    },
  },
  {
    name: CfnKey.ENGINE_VERSION,
    question: {
      type: "enum",
      label: "Aurora PostgreSQL version",
      hint: "Aurora PostgreSQL is wire-compatible with PostgreSQL.",
      options: [
        { value: "16.4", label: "Aurora PostgreSQL 16.4", recommended: true },
        { value: "15.8", label: "Aurora PostgreSQL 15.8 (stable)" },
      ],
      showIf: { field: CfnKey.ENGINE, value: RdsEngineId.AURORA_POSTGRESQL },
      fetcher: "discover-rds-engine-versions",
    },
  },
];
