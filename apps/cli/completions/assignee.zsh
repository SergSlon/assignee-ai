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
        'clean:Remove stale checkpoints, expired cache, rotate memory files, and destroy test AWS resources'
        'reconcile:Reconcile drifted resources back to desired state'
        'cache:Manage the CloudFormation schema cache'
        'doctor:Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices'
        'whoami:Print the operator AWS identity, region and active config — fast pre-flight check'
        'patterns:List and inspect compound architecture patterns'
        'types:List and inspect the CloudFormation resource types assignee can provision'
      )
      _describe 'command' commands
      ;;
    args)
      case "${words[1]}" in
        plan)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--no-apply[Skip the apply prompt after plan display]' \
            '--no-advice[Skip inline contextual advice generation]' \
            '--source[Path to local files to upload after provisioning (e.g., static site)]:path:' \
            '--set[Pre-set field values, supports human names (e.g., --set size=t3.medium)]:key=value...:'
          ;;
        apply)
          _arguments \
            '--wizard[Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent)]' \
            '--no-advice[Skip inline contextual advice generation]' \
            '--yes[Auto-confirm apply without interactive prompt (for CI/CD)]' \
            '--checkpoint[Use a saved plan checkpoint instead of running Phase 1]:path:' \
            '--source[Path to local files to upload after provisioning (e.g., static site)]:path:' \
            '--set[Pre-set wizard field values (repeatable)]:key=value...:'
          ;;
        init)
          _arguments \
            '--global[Create global user config (~/.config/assignee/config.yaml) instead of project config]'
          ;;
        completions)
          ;;
        destroy)
          _arguments \
            '--yes[Auto-confirm destroy without interactive prompt (for CI/CD)]' \
            '--all[Destroy all managed resources]' \
            '--include-iam[Include IAM policies/roles (excluded by default with --all)]' \
            '--dry-run[Show what would be destroyed without doing it]'
          ;;
        drift)
          _arguments \
            '--resource[Filter by resource type]:type:' \
            '--region[Filter by AWS region]:region:' \
            '--status[Filter by drift status]:status:' \
            '--exclude[Exclude a drift status from output (e.g. --exclude BASELINE_MISSING for CI)]:status:' \
            '--baseline[Adopt the given [resource-id] into drift tracking by snapshotting its live CCAPI state as a baseline]' \
            '--json[Output as JSON]' \
            '--output[Write JSON report to file (requires --json)]:file:' \
            '--concurrency[Max parallel drift checks (default 10, max 50)]:n:' \
            '--no-color[Disable color output]' \
            '--verbose[Show all fields including matching ones]'
          ;;
        optimize)
          _arguments \
            '--region[AWS region to scan (defaults to AWS_REGION env var)]:region:' \
            '--json[Emit recommendations as JSON instead of a table]' \
            '--reconcile[Print suggested `assignee plan` commands for each recommendation (operator still runs them manually)]' \
            '--min-savings[Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)]:usd:' \
            '--no-color[Disable color output]'
          ;;
        list)
          _arguments \
            '--json[Output as JSON array]' \
            '--region[Filter to a specific AWS region]:region:' \
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
            '--json[Output status data as JSON]' \
            '--region[Filter to a specific AWS region]:region:' \
            '--bp-coverage[Show BP rule coverage dashboard]' \
            '--gaps-only[With --bp-coverage\: print only the list of resource types with zero BP rules, and exit non-zero if any gaps are found (CI-friendly)]'
          ;;
        clean)
          _arguments \
            '--dry-run[Preview cleanup without making changes (default)]' \
            '--confirm[Execute cleanup (default is dry-run preview)]' \
            '--yes[Alias for --confirm (CI-friendly)]' \
            '--checkpoints[Only clean checkpoint files]' \
            '--cache[Only clean price cache]' \
            '--memory[Only rotate memory files]' \
            '--resources[Destroy stale e2e/test AWS resources]' \
            '--logs[Prune persistent warn/error log files older than the retention window (ASSIGNEE_LOG_RETENTION_DAYS, default 14 days)]' \
            '--baselines[Remove all baseline files adopted via `assignee drift --baseline`]' \
            '--json[Output results as JSON]'
          ;;
        reconcile)
          _arguments \
            '--resource[Filter by resource type]:type:' \
            '--dry-run[Show what would be reconciled without making changes]' \
            '--auto-reconcile[Reconcile all drifted resources without prompting]'
          ;;
        cache)
          ;;
        doctor)
          _arguments \
            '--json[Emit the report as JSON instead of formatted text]' \
            '--skip-bedrock[Skip the Bedrock LLM invoke check]' \
            '--skip-mcp[Skip the MCP server launch probe]'
          ;;
        whoami)
          ;;
        patterns)
          ;;
        types)
          ;;
      esac
      ;;
  esac
}

_assignee
