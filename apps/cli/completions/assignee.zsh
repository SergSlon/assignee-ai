#compdef assignee

# Zsh completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: eval "$(assignee completions zsh)" or add to ~/.zshrc

_assignee() {
  local -a commands

  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case "$state" in
    command)
      commands=(
        'plan:Generate an infrastructure plan from natural language intent'
        'apply:Execute an approved infrastructure plan'
        'init:Initialize assignee.ai project configuration'
        'completions:Output shell completion script'
        'destroy:Safely destroy a managed AWS resource'
        'drift:Check managed resources for configuration drift'
        'optimize:Scan managed resources for cost-rightsizing opportunities'
        'list:List all resources managed by assignee.ai'
        'setup:Create IAM users and policies for least-privilege credential separation The operator role is REQUIRED — setup aborts if it fails.'
        'status:Show summary of managed infrastructure'
        'reconcile:Reconcile drifted resources back to desired state'
        'doctor:Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices'
        'version:Show version and environment info'
      )
      _describe 'command' commands
      ;;
    args)
      case "${words[1]}" in
        plan)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json (emit machine-readable envelope)]' \
            '--no-apply[Skip the apply prompt after plan display]' \
            '--no-advice[Skip inline contextual advice generation]' \
            '--source[Path to local files to upload after provisioning (e.g., static site)]:path:' \
            '--set[Pre-set field values (repeatable), supports human names (e.g., --set size=t3.medium)]:key=value:' \
            '--yes[Accepted for CI wrapper compatibility; plan is read-only and does not mutate.]' \
            '--quick[Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before generating the plan.]' \
            '--wizard[Run the interactive configuration wizard.]' \
            '--target-account[Target AWS account ID (12 digits). Validates format; cross-account assume-role is not yet supported.]:id:'
          ;;
        apply)
          _arguments \
            '--wizard[Run the interactive configuration wizard.]' \
            '--quick[Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before provisioning.]' \
            '--no-advice[Skip inline contextual advice generation]' \
            '--yes[Auto-confirm apply without interactive prompt (for CI/CD)]' \
            '--checkpoint[Use a saved plan checkpoint instead of running Phase 1]:path:' \
            '--source[Path to local files to upload after provisioning (e.g., static site)]:path:' \
            '--set[Pre-set wizard field values (repeatable)]:key=value...:' \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json (emit machine-readable envelope)]' \
            '--target-account[Target AWS account ID (12 digits). Validates format; cross-account assume-role is not yet supported.]:id:'
          ;;
        init)
          _arguments \
            '--global[Create global user config (~/.config/assignee/config.yaml) instead of project config]' \
            '--yes[Skip interactive prompts and accept defaults (CI scriptability)]' \
            '--wizard[Run the interactive configuration wizard.]' \
            '--region[AWS region to write into the config (skips the region prompt)]:region:' \
            '--auto-fix[Set preferences.auto_fix mode\: ask | apply | skip (skips the auto-fix prompt)]:mode:' \
            '--profile[AWS profile to use for credential resolution (reads ~/.aws/config; supports SSO, assumed-role, static)]:profile:'
          ;;
        completions)
          ;;
        destroy)
          _arguments \
            '--yes[Auto-confirm destroy without interactive prompt (for CI/CD)]' \
            '--pending-window-in-days[KMS keys only\: pending-deletion window (7-30 days, default 7). KMS keys continue billing until the window elapses.]:n:' \
            '--recovery-window-in-days[SecretsManager secrets only\: recovery window (7-30 days, default 7). Secrets continue billing until the window elapses.]:n:' \
            '--force-delete-without-recovery[SecretsManager secrets only\: skip the recovery window and destroy the secret immediately. Mutually exclusive with --recovery-window-in-days.]' \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json (emit machine-readable envelope)]' \
            '--target-account[Target AWS account ID (12 digits). Validates format; cross-account assume-role is not yet supported.]:id:'
          ;;
        drift)
          _arguments \
            '--resource[Filter by resource type]:type:' \
            '--region[Filter by AWS region]:region:' \
            '--status[Filter by drift status]:status:' \
            '--exclude[Exclude a drift status from output (e.g. --exclude BASELINE_MISSING for CI)]:status:' \
            '--baseline[Adopt the given [resource-id] into drift tracking by snapshotting its live CCAPI state as a baseline]' \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json]' \
            '--output-file[Write JSON report to file (requires --json)]:file:' \
            '--concurrency[Max parallel drift checks (default 10, max 50)]:n:' \
            '--detailed[Show all fields including matching ones]' \
            '--wizard[Run interactive configuration wizard (drift is read-only; aliased to --detailed to show every field).]'
          ;;
        optimize)
          _arguments \
            '--region[AWS region to scan (defaults to AWS_REGION env var)]:region:' \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json]' \
            '--min-savings[Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)]:usd:'
          ;;
        list)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json]' \
            '--region[Filter to a specific AWS region]:region:' \
            '--resource-type[Filter to one CFN resource type (e.g. AWS\:\:S3\:\:Bucket or shorthand S3, Lambda)]:type:' \
            '--total-cost[After the table, print a total estimated monthly cost across all resources (skips Free / N/A / unparseable entries)]'
          ;;
        setup)
          _arguments \
            '--profile[AWS CLI profile with admin/root credentials (reads from ~/.aws/credentials)]:profile:' \
            '--yes[Skip confirmation prompts]' \
            '--enable-llm-logging[PRIVACY\: Enable Bedrock invocation text logging to CloudWatch (logs every prompt and response). Default\: OFF.]' \
            '--disable-llm-logging[PRIVACY\: Explicitly DISABLE Bedrock invocation text logging (idempotent). Runs only the PutModelInvocationLoggingConfiguration call with textDataDeliveryEnabled=false; does NOT re-run the full IAM wizard. Mutually exclusive with --enable-llm-logging.]' \
            '--dry-run[Print the plan of resources that WOULD be created without invoking any AWS APIs]'
          ;;
        status)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json]' \
            '--region[Filter to a specific AWS region]:region:' \
            '--resource-type[Filter to one CFN resource type (e.g. AWS\:\:S3\:\:Bucket or shorthand S3, Lambda)]:type:' \
            '--bp-coverage[Show BP rule coverage dashboard]' \
            '--gaps-only[Only meaningful with --bp-coverage. Prints just the list of resource types with zero BP rules and exits non-zero if any gaps are found (CI-friendly). Structural types (RouteTable, VPCGatewayAttachment, etc.) are excluded by default — override with --include-structural-gaps.]' \
            '--include-structural-gaps[Only meaningful with --bp-coverage --gaps-only. Includes structural/cross-reference types (RouteTable, VPCGatewayAttachment, SubnetRouteTableAssociation, EFS\:\:MountTarget) in the gap list. Default is to exclude them because their BP content lives on child resources by design.]'
          ;;
        reconcile)
          _arguments \
            '--resource[Filter by resource type]:type:' \
            '--dry-run[Show what would be reconciled without making changes]' \
            '--yes[Non-interactive mode — reconcile every drifted resource without prompting (canonical CI flag)]' \
            '--auto-reconcile[(deprecated alias for --yes) Reconcile all drifted resources without prompting. Prefer --yes; this alias is retained for backward compatibility and may be removed in a future major version.]' \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json (emit machine-readable envelope)]'
          ;;
        doctor)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--json[Shorthand for --output json]' \
            '--skip-bedrock[Skip the Bedrock LLM invoke check]' \
            '--skip-mcp[Skip the MCP server launch probe]' \
            '--short[Fast identity-only summary\: STS account + ARN + region + active config (replaces the removed `whoami` command)]'
          ;;
        version)
          _arguments \
            '--json[Emit machine-readable JSON to stdout instead of human-readable text]'
          ;;
      esac
      ;;
  esac
}

_assignee
