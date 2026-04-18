# Fish completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: assignee completions fish | source
#   or save to ~/.config/fish/completions/assignee.fish

complete -c assignee -f

complete -c assignee -n __fish_use_subcommand -a plan -d 'Generate an infrastructure plan from natural language intent'
complete -c assignee -n __fish_use_subcommand -a apply -d 'Execute an approved infrastructure plan'
complete -c assignee -n __fish_use_subcommand -a init -d 'Initialize assignee.ai project configuration'
complete -c assignee -n __fish_use_subcommand -a completions -d 'Output shell completion script'
complete -c assignee -n __fish_use_subcommand -a destroy -d 'Safely destroy a managed AWS resource'
complete -c assignee -n __fish_use_subcommand -a drift -d 'Check managed resources for configuration drift'
complete -c assignee -n __fish_use_subcommand -a optimize -d 'Scan managed resources for cost-rightsizing opportunities'
complete -c assignee -n __fish_use_subcommand -a list -d 'List all resources managed by assignee.ai'
complete -c assignee -n __fish_use_subcommand -a setup -d 'Create IAM users and policies for least-privilege credential separation The operator role is REQUIRED — setup aborts if it fails.'
complete -c assignee -n __fish_use_subcommand -a status -d 'Show summary of managed infrastructure'
complete -c assignee -n __fish_use_subcommand -a reconcile -d 'Reconcile drifted resources back to desired state'
complete -c assignee -n __fish_use_subcommand -a doctor -d 'Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices'

# Options for 'plan'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l output -s o -r -d 'Output format (json|text)'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l no-apply -d 'Skip the apply prompt after plan display'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l no-advice -d 'Skip inline contextual advice generation'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l source -s s -r -d 'Path to local files to upload after provisioning (e.g., static site)'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l set -r -d 'Pre-set field values, supports human names (e.g., --set size=t3.medium)'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l yes -s y -d 'Accepted for CI wrapper compatibility; plan is read-only and does not mutate.'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l quick -d 'Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before generating the plan.'

# Options for 'apply'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l wizard -d 'Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l quick -d 'Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before provisioning.'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l no-advice -d 'Skip inline contextual advice generation'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l yes -s y -d 'Auto-confirm apply without interactive prompt (for CI/CD)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l checkpoint -s c -r -d 'Use a saved plan checkpoint instead of running Phase 1'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l source -s s -r -d 'Path to local files to upload after provisioning (e.g., static site)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l set -r -d 'Pre-set wizard field values (repeatable)'

# Options for 'init'
complete -c assignee -n "__fish_seen_subcommand_from init" -l global -d 'Create global user config (~/.config/assignee/config.yaml) instead of project config'

# Options for 'destroy'
complete -c assignee -n "__fish_seen_subcommand_from destroy" -l yes -s y -d 'Auto-confirm destroy without interactive prompt (for CI/CD)'

# Options for 'drift'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l resource -r -d 'Filter by resource type'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l region -r -d 'Filter by AWS region'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l status -r -d 'Filter by drift status'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l exclude -r -d 'Exclude a drift status from output (e.g. --exclude BASELINE_MISSING for CI)'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l baseline -d 'Adopt the given [resource-id] into drift tracking by snapshotting its live CCAPI state as a baseline'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l json -d 'Output as JSON'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l output -r -d 'Write JSON report to file (requires --json)'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l concurrency -r -d 'Max parallel drift checks (default 10, max 50)'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l no-color -d 'Disable color output'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l verbose -d 'Show all fields including matching ones'
complete -c assignee -n "__fish_seen_subcommand_from drift" -l yes -s y -d 'Accepted for CI wrapper compatibility; drift is read-only and does not mutate.'

# Options for 'optimize'
complete -c assignee -n "__fish_seen_subcommand_from optimize" -l region -r -d 'AWS region to scan (defaults to AWS_REGION env var)'
complete -c assignee -n "__fish_seen_subcommand_from optimize" -l json -d 'Emit recommendations as JSON instead of a table'
complete -c assignee -n "__fish_seen_subcommand_from optimize" -l min-savings -r -d 'Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)'
complete -c assignee -n "__fish_seen_subcommand_from optimize" -l no-color -d 'Disable color output'

# Options for 'list'
complete -c assignee -n "__fish_seen_subcommand_from list" -l json -d 'Output as JSON array'
complete -c assignee -n "__fish_seen_subcommand_from list" -l region -r -d 'Filter to a specific AWS region'
complete -c assignee -n "__fish_seen_subcommand_from list" -l total-cost -d 'After the table, print a total estimated monthly cost across all resources (skips Free / N/A / unparseable entries)'

# Options for 'setup'
complete -c assignee -n "__fish_seen_subcommand_from setup" -l profile -r -d 'AWS CLI profile with admin/root credentials (reads from ~/.aws/credentials)'
complete -c assignee -n "__fish_seen_subcommand_from setup" -l yes -s y -d 'Skip confirmation prompts'
complete -c assignee -n "__fish_seen_subcommand_from setup" -l enable-llm-logging -d 'PRIVACY: Enable Bedrock invocation text logging to CloudWatch (logs every prompt and response). Default: OFF.'
complete -c assignee -n "__fish_seen_subcommand_from setup" -l disable-llm-logging -d 'PRIVACY: Explicitly DISABLE Bedrock invocation text logging (idempotent). Runs only the PutModelInvocationLoggingConfiguration call with textDataDeliveryEnabled=false; does NOT re-run the full IAM wizard. Mutually exclusive with --enable-llm-logging.'
complete -c assignee -n "__fish_seen_subcommand_from setup" -l dry-run -d 'Print the plan of resources that WOULD be created without invoking any AWS APIs'

# Options for 'status'
complete -c assignee -n "__fish_seen_subcommand_from status" -l json -d 'Output status data as JSON'
complete -c assignee -n "__fish_seen_subcommand_from status" -l region -r -d 'Filter to a specific AWS region'
complete -c assignee -n "__fish_seen_subcommand_from status" -l bp-coverage -d 'Show BP rule coverage dashboard'
complete -c assignee -n "__fish_seen_subcommand_from status" -l gaps-only -d 'Only meaningful with --bp-coverage. Prints just the list of resource types with zero BP rules and exits non-zero if any gaps are found (CI-friendly). Structural types (RouteTable, VPCGatewayAttachment, etc.) are excluded by default — override with --include-structural-gaps.'
complete -c assignee -n "__fish_seen_subcommand_from status" -l include-structural-gaps -d 'Only meaningful with --bp-coverage --gaps-only. Includes structural/cross-reference types (RouteTable, VPCGatewayAttachment, SubnetRouteTableAssociation, EFS::MountTarget) in the gap list. Default is to exclude them because their BP content lives on child resources by design.'

# Options for 'reconcile'
complete -c assignee -n "__fish_seen_subcommand_from reconcile" -l resource -r -d 'Filter by resource type'
complete -c assignee -n "__fish_seen_subcommand_from reconcile" -l dry-run -d 'Show what would be reconciled without making changes'
complete -c assignee -n "__fish_seen_subcommand_from reconcile" -l yes -s y -d 'Non-interactive mode — reconcile every drifted resource without prompting (canonical CI flag)'
complete -c assignee -n "__fish_seen_subcommand_from reconcile" -l auto-reconcile -d '(deprecated alias for --yes) Reconcile all drifted resources without prompting. Prefer --yes; this alias is retained for backward compatibility and may be removed in a future major version.'

# Options for 'doctor'
complete -c assignee -n "__fish_seen_subcommand_from doctor" -l json -d 'Emit the report as JSON instead of formatted text'
complete -c assignee -n "__fish_seen_subcommand_from doctor" -l skip-bedrock -d 'Skip the Bedrock LLM invoke check'
complete -c assignee -n "__fish_seen_subcommand_from doctor" -l skip-mcp -d 'Skip the MCP server launch probe'
complete -c assignee -n "__fish_seen_subcommand_from doctor" -l short -d 'Fast identity-only summary: STS account + ARN + region + active config (replaces the removed `whoami` command)'
