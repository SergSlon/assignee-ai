/**
 * Doctor check — npm registry reachability (PR-013 / W24c-S3).
 *
 * `update-notifier` fires an async registry HEAD call on every CLI
 * invocation (unless suppressed). Behind corporate proxies that require
 * auth or strip the registry CA, this fails silently — operators stay on
 * stale versions indefinitely with no feedback.
 *
 * This sub-check makes the failure visible: it performs a short HEAD
 * request to `https://registry.npmjs.org/assignee` with a 3-second
 * timeout. If it succeeds the operator knows update-checks will work.
 * If it fails, they see the HTTPS_PROXY hint and can act.
 *
 * Design:
 *   - Uses Node's native `fetch` (available since Node 18).
 *   - 3-second timeout via `AbortController`.
 *   - `deps.fetchImpl` is injectable so tests never make real HTTP calls.
 *   - Sub-check status "warn" (not "fail") — registry unreachability is
 *     not a hard CLI blocker (ASSIGNEE_NO_UPDATE_CHECK=1 suppresses the
 *     notifier entirely), but operators should know about it.
 */

import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

/** Timeout for the registry HEAD call (ms). */
const REGISTRY_TIMEOUT_MS = 3000;

/** URL probed for reachability. */
const REGISTRY_URL = "https://registry.npmjs.org/assignee";

/**
 * Minimal fetch surface consumed by this check.
 * Matches the Node native `fetch` signature for the subset we use.
 */
export interface RegistryFetchFn {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number }>;
}

export interface RegistryCheckDeps {
  /** Override the fetch implementation (test injection — prevents real HTTP). */
  fetchImpl?: RegistryFetchFn;
  /** Override the timeout in ms (test injection). */
  timeoutMs?: number;
}

/**
 * Run the npm registry reachability sub-check.
 *
 * Returns `[ok]` when the registry responds to a HEAD request within the
 * timeout window, `[!]` with HTTPS_PROXY guidance when it times out or
 * errors.
 */
async function registryReachabilitySubCheck(
  deps: RegistryCheckDeps,
): Promise<DoctorSubCheck> {
  const timeoutMs = deps.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as RegistryFetchFn);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(REGISTRY_URL, {
      method: "HEAD",
      signal: controller.signal,
    });

    if (res.ok || res.status === 200) {
      return {
        label: "npm registry reachability",
        status: "ok",
        detail: `${REGISTRY_URL} responded (HTTP ${res.status}) — update-notifier will work`,
      };
    }

    // Non-OK response (e.g. 4xx from a filtering proxy)
    return {
      label: "npm registry reachability [!]",
      status: "warn",
      detail:
        `${REGISTRY_URL} returned HTTP ${res.status}. ` +
        `update-notifier may not display upgrade banners. ` +
        `If behind a corporate proxy, set HTTPS_PROXY=http://<proxy>:<port> or ` +
        `ASSIGNEE_NO_UPDATE_CHECK=1 to suppress the check.`,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));

    const detail = isTimeout
      ? `Registry check timed out after ${timeoutMs}ms — update-notifier may not work behind this proxy. ` +
        `Set HTTPS_PROXY=http://<proxy>:<port> (or ASSIGNEE_NO_UPDATE_CHECK=1 to suppress).`
      : `Cannot reach npm registry (${err instanceof Error ? err.message : String(err)}). ` +
        `If behind a corporate proxy, set HTTPS_PROXY=http://<proxy>:<port> or ` +
        `ASSIGNEE_NO_UPDATE_CHECK=1 to suppress the update check.`;

    return {
      label: "npm registry reachability [!]",
      status: "warn",
      detail,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the full registry doctor section.
 *
 * Section name: "npm registry"
 * Sub-checks:
 *   1. Registry reachability — HEAD probe with timeout.
 */
export async function checkRegistry(
  deps: RegistryCheckDeps = {},
): Promise<DoctorSection> {
  const reachability = await registryReachabilitySubCheck(deps);
  const subs: DoctorSubCheck[] = [reachability];

  return {
    name: "npm registry",
    status: rollup(subs),
    subs,
  };
}
