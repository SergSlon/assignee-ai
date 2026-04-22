# Bash completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: eval "$(assignee completions bash)" or add to ~/.bashrc

_assignee_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="plan apply init completions destroy drift optimize list setup status reconcile doctor version"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return 0
  fi

  local command="${COMP_WORDS[1]}"
  case "${command}" in
    plan)
      COMPREPLY=( $(compgen -W "--output --json --no-apply --no-advice --source --set --yes --quick --wizard" -- "${cur}") )
      ;;
    apply)
      COMPREPLY=( $(compgen -W "--wizard --quick --no-advice --yes --checkpoint --source --set --output --json" -- "${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--global --yes --region --auto-fix" -- "${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    destroy)
      COMPREPLY=( $(compgen -W "--yes --pending-window-in-days --recovery-window-in-days --force-delete-without-recovery --output --json" -- "${cur}") )
      ;;
    drift)
      COMPREPLY=( $(compgen -W "--resource --region --status --exclude --baseline --json --output-file --concurrency --detailed --yes" -- "${cur}") )
      ;;
    optimize)
      COMPREPLY=( $(compgen -W "--region --json --min-savings" -- "${cur}") )
      ;;
    list)
      COMPREPLY=( $(compgen -W "--json --region --resource-type --total-cost" -- "${cur}") )
      ;;
    setup)
      COMPREPLY=( $(compgen -W "--profile --yes --enable-llm-logging --disable-llm-logging --dry-run" -- "${cur}") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--json --region --resource-type --bp-coverage --gaps-only --include-structural-gaps" -- "${cur}") )
      ;;
    reconcile)
      COMPREPLY=( $(compgen -W "--resource --dry-run --yes --auto-reconcile --output --json" -- "${cur}") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--json --skip-bedrock --skip-mcp --short" -- "${cur}") )
      ;;
    version)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
  esac
  return 0
}

complete -F _assignee_completions assignee
