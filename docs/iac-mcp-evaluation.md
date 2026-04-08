# AWS Labs IaC MCP Server — adoption evaluation

> Research spike (read-only). Evaluates whether `awslabs.aws-iac-mcp-server`
> — the announced replacement for `ccapi-mcp-server` and `cfn-mcp-server` —
> should be adopted by Assignee.ai. Date: **2026-04-08**.
>
> **Recommendation: SKIP** for now. Set two watch triggers, listed at the
> end. The new server's high-value capabilities (cfn-guard, stack
> troubleshooter) either duplicate existing in-pipeline checks we already
> have or strictly require a CloudFormation stack — which we don't use.

## 1. Deprecation status (the trigger for this spike)

Both legacy servers are now **explicitly** deprecated on
`awslabs.github.io/mcp/`:

| Legacy server              | Status verbatim from awslabs.github.io                                                                                          | Our migration                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `awslabs.ccapi-mcp-server` | "⚠️ DEPRECATION NOTICE: This server is deprecated and will no longer receive updates."                                          | Done in **Story 7.6** — replaced with `@aws-sdk/client-cloudcontrol` direct calls. Guardrail at `apps/cli/src/config/mcp-servers.test.ts:94`. |
| `awslabs.cfn-mcp-server`   | "⚠️ DEPRECATION NOTICE: This server is deprecated and will no longer receive updates. Please migrate to the AWS IAC MCP Server" | Done in **Story 31.1** — CloudFormation schemas now via `@aws-sdk/client-cloudformation` `DescribeType`. Same guardrail.                      |

Both deprecation notices direct migrators to **AWS IaC MCP Server**.

The CCAPI service itself is **not** deprecated — only the MCP wrappers.
Quote: _"The deprecation affects only this specific MCP wrapper. The
underlying AWS Cloud Control API service itself remains active and
supported by AWS — only the MCP server interface for accessing it is
being retired."_ We use the SDK directly so the wrapper deprecation is
zero runtime impact.

## 2. What the new server actually is

`awslabs.aws-iac-mcp-server` is **not** a CCAPI replacement. It is a
**reference + validation + troubleshooting** server. Its tool surface,
verbatim from the docs:

| Tool                                                    | Purpose                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `read_iac_documentation_page`                           | Fetches & converts CDK or CloudFormation docs to markdown                                        |
| `validate_cloudformation_template`                      | Syntax, schema, and resource property validation via **cfn-lint**                                |
| `check_cloudformation_template_compliance`              | Security/compliance rule validation using **cfn-guard**                                          |
| `troubleshoot_cloudformation_deployment`                | Analyzes failed stacks; pattern-matches **30+ failure cases** (requires `stack_name` + `region`) |
| `search_cloudformation_documentation`                   | Queries CloudFormation KB for resource types & syntax                                            |
| `get_cloudformation_pre_deploy_validation_instructions` | Returns CLI commands for change-set validation                                                   |
| `search_cdk_documentation`                              | Searches CDK API, best practices, samples via KB                                                 |
| `search_cdk_samples_and_constructs`                     | CDK code examples, constructs, patterns (multi-language)                                         |
| `cdk_best_practices`                                    | CDK guidance: config, coding, constructs, security, testing                                      |

**Notably absent:** `create_resource`, `get_resource`, `update_resource`,
`delete_resource`, `list_resources`, `get_resource_schema_information`,
`get_request_status`. These were in `ccapi-mcp-server`'s surface and
remain the responsibility of the (also deprecated) `ccapi-mcp-server` —
or, in our case, of `@aws-sdk/client-cloudcontrol` directly.

## 3. Capability-by-capability comparison

### 3.1 cfn-guard vs our BP engine

| Dimension        | `cfn-guard` (AWS IaC MCP)                                   | Assignee.ai BP engine                                                                                                                                |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where checks run | Static scan of a finished CFN template                      | Pipeline node `bp_evaluator`, against the LLM-generated structured `desiredState` BEFORE plan generation finalizes                                   |
| Rule source      | AWS Guard Rules Registry + Control Tower proactive controls | 136 hand-curated YAML rules across 19 services in `packages/best-practices/`                                                                         |
| Rule metadata    | Pass/fail + remediation text                                | `severity`, `category`, `propertyPath`, `autoFixable`, `desiredStatePatch`, `consequence`, `lastVerified`, `blocking`, `source`, `source_id`         |
| Auto-fix         | None — rules are reporting only                             | `desiredStatePatch` lets `fix_applicator` auto-apply patches with user consent (user-configured at init time per `feedback_autofix_user_decides.md`) |
| User correlation | Per-template only                                           | Per-finding, per-resource, structured into the plan box, integrated with `assignee plan` UX                                                          |
| Loaded against   | YAML/JSON template artefact                                 | `AgentState.desiredState` JSON (the same shape we send to CCAPI)                                                                                     |
| Integrity        | Bundled with the wrapper, no signing surface documented     | `manifest.json` hash check + optional GPG signature gate via `ASSIGNEE_BP_INTEGRITY` / `ASSIGNEE_BP_REQUIRE_SIGNATURE`                               |

**Verdict.** Architectural mismatch — cfn-guard is a post-hoc template
scanner; our BP engine runs during the pipeline against structured
intent. Adopting cfn-guard would mean either (a) generating a
synthetic template just to feed it to the scanner (the same hack
`ccapi-mcp-server`'s `generate_infrastructure_code()` did) or (b)
rebuilding our pipeline around CloudFormation templates. Neither is
worth doing for what is mostly overlap with our own 136-rule engine.

**However:** there's a real question about **rule coverage overlap**.
cfn-guard pulls from the AWS Guard Rules Registry, which is broader
than our 19-service curated set. A separate spike could:

- Diff cfn-guard's S3/IAM/EC2/RDS/Lambda rule names against our
  `BP-S3-*` / `BP-IAM-*` / etc. IDs
- Identify rules cfn-guard catches that we don't
- Decide whether to port the gap rules into our YAML format (where
  we'd retain `propertyPath` + `autoFixable` + `desiredStatePatch`)

That's a focused 2-hour follow-up, not a server adoption.

### 3.2 cfn-lint vs our schema validation

| Dimension         | `validate_cloudformation_template`                                                         | Assignee.ai                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it validates | Syntax errors, invalid properties, schema violations in YAML/JSON CloudFormation templates | Per-resource schema fetched via `@aws-sdk/client-cloudformation` `DescribeType`, used by `schema_fetcher` node + `plan_generator` LLM prompt + `preflight_guard` |
| Input             | A finished CFN template (string)                                                           | Structured `desiredState` JSON for one resource type at a time                                                                                                   |
| When it runs      | After someone has produced a template                                                      | Before the LLM plan is finalized (built into the pipeline)                                                                                                       |

**Verdict.** Irrelevant for our architecture today. We do not import
or generate YAML/JSON CloudFormation templates anywhere — we hand
structured `desiredState` to CCAPI directly. `validate_cloudformation_template`
would only become useful if we ever supported template import (e.g. an
`assignee from-template ./infra.yml` command), which is not in any
sprint plan.

### 3.3 troubleshoot_cloudformation_deployment vs `assignee status`

This was the **highest-leverage** capability of the new server in the
original handoff. Verified with a focused fetch:

> The tool **strictly requires a CloudFormation stack** to function.
> The required parameters are:
>
> - `stack_name` (required): Name of the failed CloudFormation stack
> - `region` (required): AWS region where the stack exists
>   The tool cannot troubleshoot Cloud Control API direct provisioning
>   failures, as it depends on CloudFormation stack context.

**Verdict.** Unreachable for our architecture. We use CCAPI direct
provisioning — there is no `stack_name` to pass. The 30+ failure
patterns may include CCAPI failure modes internally, but the tool's
input contract requires a stack and there is no documented way to
invoke it without one. This was the single most appealing piece of
the new server, and it does not apply.

Our equivalent surface is `assignee status <token>` + the local
checkpoint files. Improving CCAPI failure-mode classification is
better done in our own `destroy-service.ts` / `result-formatter.ts`
where we already pattern-match `NotFound`, `AccessDenied`,
`BucketNotEmpty`, `RequestLimitExceeded`, etc. (per the existing
`feedback_cloudcontrol_notfound_short_circuit.md` etc.).

### 3.4 CDK integration

Three CDK tools (`search_cdk_documentation`, `search_cdk_samples_and_constructs`,
`cdk_best_practices`) — all read-only doc lookup over the CDK API
reference, samples, and best practices guide.

**Verdict.** Irrelevant. Assignee.ai does not target CDK output —
`assignee init` generates `.assignee/config.yaml`, not `cdk.json` or
`cdk.context.json`. There is no story planned for a CDK output target.
If that ever changes (a stretch — we'd need a whole code-generation
node), this would become marginally useful for `assignee init`'s
"recommended construct" hints.

### 3.5 Documentation lookup

`read_iac_documentation_page` + `search_cloudformation_documentation`
overlap with our existing `awslabs.aws-documentation-mcp-server` (a
core MCP server we already spawn). The CFN-specific search is
narrower than our docs server's general AWS coverage.

**Verdict.** Already covered. No reason to spawn a second
documentation server for the same content.

## 4. Operational concerns

These are independent of capability and apply to any adoption decision.

### 4.1 Auth model collision

The new server expects credentials via the **standard AWS chain**:
`AWS_PROFILE`, then `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY`, then
SSO. We deliberately do not use the standard chain — `aws-credentials.ts`
intentionally bypasses it to enforce the 3-role separation
(operator/reader/auditor) per `feedback_lazy_credential_resolution_in_mcp.md`.

Adopting `aws-iac-mcp-server` would require either:

- Spawning it under reader credentials (the validate/lint/troubleshoot
  operations are read-only), OR
- Mapping `ASSIGNEE_READER_*` env vars onto `AWS_ACCESS_KEY_ID` / etc.
  in the per-server config — same shim we already use for the existing
  awslabs servers in `apps/cli/src/config/mcp-servers.ts`.

Tractable, but adds another shim row.

### 4.2 Supply-chain pinning

The page documents `uvx awslabs.aws-iac-mcp-server@latest` only —
**no semantic version pinning**. This is the exact problem the
`mcp-servers.test.ts` pinning regex (`/awslabs\.foo-mcp-server@\d+\.\d+\.\d+/`)
exists to prevent (`feedback_simulate_ci_no_creds.md` → "Wave-2 security
hardening: every MCP server package is PINNED to an exact version
(no @latest)").

Adopting an unpinned server is a regression of our supply-chain stance.
We would need to:

1. Find a stable version on PyPI (`awslabs-aws-iac-mcp-server`)
2. Pin it in `MCP_PINS` next to the existing entries
3. Add a new pinning regex test in `mcp-servers.test.ts`

Until AWS Labs publishes a stable version, this is a blocker.

### 4.3 Spawn cost

Each MCP server is a uvx subprocess with its own process startup,
import cost, and per-call latency. The current cold-start budget
already allocates `MCP_STARTUP_PER_SERVER_MS = 1000` ms per server
(`apps/cli/src/constants/time-budget.ts`). Adding a 6th server pushes
the worst-case `MCP_TOTAL_PLAN` from 3,000 ms (current budget) to a
risk of crossing it on slower hosts.

This is fixable via `getRequiredServers` (Story 29.3 lazy-loading) so
that the IaC server only spawns for commands that need it (e.g. a
hypothetical `assignee validate <template>` command). But we don't
have any commands that would need it today.

## 5. What we already do that overlaps

Just to make the "we already have this" claim concrete:

| New-server capability                     | Our existing implementation                                                           | File reference                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Static security/compliance rule check     | 136-rule BP engine, plan-time                                                         | `packages/best-practices/*/BP-*.yaml`, `bp_evaluator` node                                                       |
| LLM-hallucinated managed-policy ARN guard | `verifyManagedPolicyArns()` (Wave 20 Bug #8)                                          | `apps/cli/src/services/preflight-guard.ts`                                                                       |
| Resource schema validation                | `cloudformation-schema-service.ts` `DescribeType` cache                               | `packages/core/src/services/cloudformation-schema-service.ts`                                                    |
| AWS doc lookup                            | `awslabs.aws-documentation-mcp-server` (core MCP, already spawned)                    | `apps/cli/src/config/mcp-servers.ts`                                                                             |
| Drift detection                           | `assignee drift` command + `createDriftDetectorFromEnv` (Stories 28.2/28.3/28.5/28.6) | `apps/cli/src/commands/drift.ts`, `apps/cli/src/services/drift-detector-factory.ts`                              |
| Failure pattern classification            | CCAPI NotFound short-circuit, IGW pre-detach hooks, etc.                              | `feedback_cloudcontrol_notfound_short_circuit.md`, `feedback_destroy_predelete_hooks_for_cfn_only_constructs.md` |

## 6. Recommendation

**SKIP adoption.** The new server's core value is in (a) cfn-guard
compliance scanning, which architecturally mismatches our plan-time
BP engine; (b) cfn-lint template validation, which doesn't apply
because we don't import templates; (c) stack troubleshooting, which
strictly requires a CloudFormation `stack_name` we never have; and
(d) CDK doc lookup, which we have no use for.

The supply-chain story (`@latest` only) is also a regression of
our pinning policy.

### 6.1 Watch triggers

Re-evaluate if any of these become true:

1. **AWS Labs publishes a stable pinned version** (e.g.
   `awslabs.aws-iac-mcp-server@1.0.0`). At that point the supply-chain
   blocker disappears and a focused 30-minute spike can re-rank.
2. **We add CDK as an output target** (e.g. an `assignee init` mode
   that scaffolds a CDK project). The CDK doc lookup tools become
   useful for grounding `assignee init`'s recommendations in real
   constructs.
3. **We add CloudFormation template import** (a hypothetical
   `assignee from-template ./infra.yml` command). At that point
   `validate_cloudformation_template` and the docs search become
   load-bearing.
4. **The drift epic A3 starts** and we want to reuse the
   "30+ failure patterns" knowledge base — even though we can't call
   `troubleshoot_cloudformation_deployment` directly without a stack,
   the pattern list itself is interesting input for our own classifier.
   If AWS publishes the pattern list separately (or it's discoverable
   via `cli-docs-mcp`), worth a port.

### 6.2 Concrete follow-ups (independent of adoption)

These are spike outputs that have value regardless of the SKIP decision:

1. **cfn-guard rule overlap diff** — pull the AWS Guard Rules Registry
   rule list, diff against our 136-rule set, identify high-value gap
   rules to port into our YAML format. Estimated 2 hours, output is a
   short list of new BP-\* IDs to author.
2. **Update `feedback_excellence_bar.md`** if you want to make the
   "we own our quality engine" stance explicit — currently the rule
   says "tests are the floor", but the BP engine is part of why our
   excellence story doesn't depend on external scanners.
3. **Add a comment to `apps/cli/src/config/mcp-servers.test.ts:94`**
   noting that the _new_ `awslabs.aws-iac-mcp-server` is also not in
   scope (the guardrail today only mentions `cfn-mcp-server`). This
   future-proofs the test against an accidental adoption commit.

None of these block CLI work or require a server adoption decision.
