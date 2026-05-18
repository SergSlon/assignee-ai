/**
 * Shared `--yes`-in-TTY warning for the destroy command.
 *
 * Single emission point used by:
 *   - `single-flow.ts` (per-resource destroy entry)
 *   - `destroy.ts` (CCAPI-bypass `confirmDestroy` for KMS / Secrets / EventBus)
 *
 * Background: the warning was duplicated across both call sites and fired
 * for every per-resource iteration of `assignee infra destroy --all`, even though
 * the bulk-destroy parent had already collected the typed
 * `DESTROY-EVERYTHING` confirmation once. The helper accepts a
 * `noConfirm: true` signal that the bulk-destroy orchestrator threads in
 * to suppress the per-key noise without touching the public CLI surface.
 */
import type { Writable } from "node:stream";

/**
 * Emit the "--yes flag used in interactive session" warning when
 * appropriate.
 *
 * Suppression rules:
 *   - `opts.yes` not set      → silent (the warning is yes-specific)
 *   - `opts.noConfirm === true` → silent (parent already gathered an
 *     explicit confirmation, e.g. bulk-destroy's typed-account-ID prompt)
 *   - non-TTY stdout          → silent (CI/CD: human prose to stderr is noise)
 *
 * The TTY check is wired against `process.stdout.isTTY` by default to
 * mirror the legacy single-flow / confirmDestroy gates exactly. Tests
 * pass an explicit boolean so they don't have to mutate global TTY state.
 */
export function maybeWarnYesInTty(
  opts: { yes?: boolean; noConfirm?: boolean },
  stderr: Writable = process.stderr,
  stdoutIsTTY: boolean = process.stdout.isTTY ?? false,
): void {
  if (!opts.yes) return;
  if (opts.noConfirm) return;
  if (!stdoutIsTTY) return;
  stderr.write(
    "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n",
  );
}
