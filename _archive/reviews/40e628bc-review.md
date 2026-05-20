# Reviewer: ACCEPT — qa (Quinn) — windows-no-coverage

## Verdict

ACCEPT. Surgical, low-risk fix. The split into POSIX (`test:coverage`) and Windows (`test`) steps with mutually-exclusive `if:` conditions is the right shape: the canonical coverage cell (ubuntu-latest+node22) is preserved, Windows skips the v8 instrumentation that triggers the vitest RPC `onTaskUpdate` heartbeat death, and `--continue` semantics are unchanged because it's a turbo flag, not a vitest flag.

## Config-claim verification

1. **Conditional logic** — `grep "inputs.os" .github/workflows/ci-core.yml` shows exactly two opposed conditions at lines 188 (`!= 'windows-latest'`) and 197 (`== 'windows-latest'`). Mutually exclusive and exhaustive over GH-Actions matrix values. PASS.
2. **`turbo test` task exists** — `turbo.json` defines both `test` (lines 10-41) and `test:coverage` (42-73) with identical inputs/env. All four packages (`apps/cli`, `apps/mcp-server`, `packages/core`, `packages/best-practices`) expose `test: vitest run` and `test:coverage: vitest run --coverage` scripts. PASS.
3. **`--continue` semantics** — turbo-level flag; behaviour identical across `test`/`test:coverage`. No regression. PASS.
4. **Downstream coverage gating** — "Merge coverage summaries" (L205), "Update coverage badge" (L231), and upload-artifact steps (L247, L256) are all gated on `inputs.publish-coverage`. The only caller passing `publish-coverage: true` is `ci.yml:ubuntu-node22` — never Windows. `ci-cross-platform.yml:107` explicitly sets `publish-coverage: false`. No downstream consumer expects Windows coverage. PASS.
5. **POSIX cells unchanged** — POSIX step still runs `npx turbo test:coverage --continue`; only delta is the new `if:` clause and a comment block. ubuntu/macos coverage flow intact. PASS.
6. **YAML syntax** — `python3 -c "import yaml; yaml.safe_load(...)"` returns clean. PASS.
7. **Tradeoff** — Windows produces no coverage artifacts; no badge/dashboard/job consumes them. Documented in the in-step comment block. PASS.

## Findings

None at BLOCKER/HIGH/MED/LOW severity.

Observations (informational, no action required):

- The two-step pattern is slightly noisier than a single step with a shell-conditional inside `run:`, but the conditional-step form is more idiomatic GH-Actions and surfaces the divergence in the run log UI. Current shape is the better choice.
- Comment block (L171-187, L191-198) is excellent — anchors the rationale at the source of truth so future maintainers don't "fix" Windows back to `test:coverage` and re-trigger the IPC timeout.

## NFR score: 96/100

- Correctness: 100 (claims verified end-to-end)
- Maintainability: 95 (rationale documented inline)
- Risk: 100 (no behavioural change on POSIX; Windows previously failed deterministically — strictly improves)
- Observability: 90 (-4: no explicit run-name distinguishing the two steps beyond the title; -nil otherwise)

## Recommendation

Land as-is. The fix is the right scope for the diagnosed root cause (v8-instrumented COLLECT exceeds vitest's IPC heartbeat on NTFS), preserves the canonical coverage cell, and unblocks the Windows-green check needed to flip `experimental: false`.
