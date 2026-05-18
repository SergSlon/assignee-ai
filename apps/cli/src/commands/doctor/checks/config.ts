/**
 * Doctor check #5 — project config file presence + YAML validity.
 *
 * The file is optional (the CLI works without it), but if present we
 * surface its path. Schema validation lives in `assignee dev init`; doctor
 * only confirms the file parses as YAML.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

export interface ConfigCheckDeps {
  cwd?: string;
}

export function checkConfig(deps: ConfigCheckDeps = {}): DoctorSection {
  const cwd = deps.cwd ?? process.cwd();
  const subs: DoctorSubCheck[] = [];
  const candidates = [
    "assignee.yaml",
    "assignee.yml",
    join(".assignee", "config.yaml"),
  ];
  let found: string | undefined;
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) {
      found = c;
      break;
    }
  }

  if (!found) {
    subs.push({
      label: "project config",
      status: "warn",
      detail: "no assignee.yaml in cwd (optional — defaults will be used)",
    });
    return { name: "Config", status: "warn", subs };
  }

  try {
    const content = readFileSync(join(cwd, found), "utf-8");
    parseYaml(content);
    subs.push({
      label: `./${found}`,
      status: "ok",
      detail: "valid YAML",
    });
  } catch (err) {
    subs.push({
      label: `./${found}`,
      status: "fail",
      detail: `failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    name: "Config",
    status: rollup(subs),
    subs,
  };
}
