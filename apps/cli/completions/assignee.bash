# Bash completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: eval "$(assignee completions bash)" or add to ~/.bashrc

_assignee_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="plan apply init completions describe destroy drift optimize list setup status reconcile doctor restore-provisions audit-verify update discover version"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return 0
  fi

  local command="${COMP_WORDS[1]}"
  case "${command}" in
    plan)
      COMPREPLY=( $(compgen -W "--output --json --no-apply --no-advice --source --set --yes --cost-detail --quick --wizard --target-account" -- "${cur}") )
      ;;
    apply)
      COMPREPLY=( $(compgen -W "--wizard --quick --no-advice --yes --checkpoint --source --set --output --json --target-account" -- "${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--global --yes --wizard --region --auto-fix --profile" -- "${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    describe)
      COMPREPLY=( $(compgen -W "--output --json" -- "${cur}") )
      ;;
    destroy)
      COMPREPLY=( $(compgen -W "--yes --pending-window-in-days --recovery-window-in-days --force-delete-without-recovery --output --json --target-account --all --no-confirm --allow-large-sweep" -- "${cur}") )
      ;;
    drift)
      COMPREPLY=( $(compgen -W "--resource --region --status --exclude --baseline --output --json --output-file --concurrency --detailed --wizard" -- "${cur}") )
      ;;
    optimize)
      COMPREPLY=( $(compgen -W "--region --output --json --min-savings" -- "${cur}") )
      ;;
    list)
      COMPREPLY=( $(compgen -W "--output --json --region --resource-type --total-cost" -- "${cur}") )
      ;;
    setup)
      COMPREPLY=( $(compgen -W "--profile --yes --enable-llm-logging --disable-llm-logging --dry-run" -- "${cur}") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--output --json --region --resource-type --bp-coverage --gaps-only --include-structural-gaps" -- "${cur}") )
      ;;
    reconcile)
      COMPREPLY=( $(compgen -W "--resource --dry-run --yes --auto-reconcile --output --json" -- "${cur}") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--output --json --skip-bedrock --skip-mcp --short" -- "${cur}") )
      ;;
    restore-provisions)
      COMPREPLY=( $(compgen -W "--from --from-audit-log --json" -- "${cur}") )
      ;;
    audit-verify)
      COMPREPLY=( $(compgen -W "--from --to --log-file --json" -- "${cur}") )
      ;;
    update)
      COMPREPLY=( $(compgen -W "--source --delete --invalidation-paths --no-invalidation --wait --yes --output --json" -- "${cur}") )
      ;;
    discover)
      COMPREPLY=( $(compgen -W "--json --category" -- "${cur}") )
      ;;
    version)
      COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
      ;;
  esac
  return 0
}

complete -F _assignee_completions assignee
