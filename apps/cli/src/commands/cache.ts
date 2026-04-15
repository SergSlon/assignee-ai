/**
 * `assignee cache` command — manage the schema cache.
 *
 * Subcommands:
 * - `assignee cache clear`   — delete all cached schemas
 * - `assignee cache refresh` — clear and re-fetch all schemas
 *
 * @see Story 31.6
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import {
  CloudFormationSchemaService,
  SchemaCacheWarmer,
  SUPPORTED_TYPES_ARRAY,
} from "@assignee/core";

export const cacheCommand = new Command("cache")
  .description("Manage the CloudFormation schema cache")
  .addHelpText(
    "after",
    `
Examples:
  $ assignee cache clear
        Delete every cached CloudFormation resource schema
  $ assignee cache refresh
        Clear and re-fetch schemas for all supported resource types

cache only touches ~/.assignee/cache/ (local disk). No AWS mutation, no
--yes required.
`,
  );

cacheCommand
  .command("clear")
  .description("Delete all cached schemas")
  .action(async () => {
    const schemaService = new CloudFormationSchemaService();
    await schemaService.invalidateCache();
    clack.log.success("Schema cache cleared");
  });

cacheCommand
  .command("refresh")
  .description("Clear and re-fetch all schemas")
  .action(async () => {
    const schemaService = new CloudFormationSchemaService();

    await schemaService.invalidateCache();
    clack.log.info("Schema cache cleared, re-fetching...");

    const spinner = clack.spinner();
    spinner.start("Pre-fetching resource schemas...");

    const warmer = new SchemaCacheWarmer(schemaService);
    const total = SUPPORTED_TYPES_ARRAY.length;

    const result = await warmer.warmAll(SUPPORTED_TYPES_ARRAY, {
      onProgress: (done, t) => {
        spinner.message(`Pre-fetching resource schemas... ${done}/${t}`);
      },
    });

    if (result.failed.length === 0) {
      spinner.stop(
        `Cached ${result.succeeded.length}/${total} resource schemas`,
      );
    } else {
      spinner.stop(
        `Cached ${result.succeeded.length}/${total} resource schemas (${result.failed.length} will be fetched on-demand)`,
      );
    }
  });
