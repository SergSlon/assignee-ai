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
        'infra:Manage cloud infrastructure (plan, apply, destroy, drift, …)'
        'admin:Inspect and verify managed resources (status, list, doctor, …)'
        'dev:Developer tooling (init, setup, completions, discover, …)'
      )
      _describe 'command' commands
      ;;
    args)
      case "${words[1]}" in
        infra)
          local -a sub_commands
          sub_commands=(
            'plan:Generate an infrastructure plan from natural language intent'
            'apply:Execute an approved infrastructure plan'
            'destroy:Safely destroy a managed AWS resource'
            'drift:Check managed resources for configuration drift'
            'reconcile:Reconcile drifted resources back to desired state'
            'optimize:Scan managed resources for cost-rightsizing opportunities'
            'restore-provisions:Restore provisions.json from a dated backup (BCP/DR)'
          )
          _describe 'sub-command' sub_commands
          ;;
        admin)
          local -a sub_commands
          sub_commands=(
            'audit-verify:Verify the HMAC chain integrity of the local audit log. Exits 0 on a clean chain; non-zero with diagnostics when the chain is broken.'
            'doctor:Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices'
            'status:Show summary of managed infrastructure'
            'list:List all resources managed by assignee.ai'
            'describe:Re-render the apply-success line for a previously-applied resource by run id or ARN'
          )
          _describe 'sub-command' sub_commands
          ;;
        dev)
          local -a sub_commands
          sub_commands=(
            'init:Initialize assignee.ai project configuration'
            'setup:Create IAM users and policies for least-privilege credential separation The operator role is REQUIRED — setup aborts if it fails.'
            'update:Refresh a deployed static-website\: upload new files to S3 and invalidate CloudFront'
            'completions:Output shell completion script'
            'discover:Browse and search all supported resource types, compound patterns, and CLI commands'
            'version:Show version and environment info'
          )
          _describe 'sub-command' sub_commands
          ;;
      esac
      ;;
  esac
}

_assignee
