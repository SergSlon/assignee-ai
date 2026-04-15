# Bash completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: eval "$(assignee completions bash)" or add to ~/.bashrc

_assignee_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="plan apply init completions destroy drift optimize list setup status clean reconcile cache doctor whoami patterns types"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return 0
  fi

  local command="${COMP_WORDS[1]}"
  case "${command}" in
    plan)
      COMPREPLY=( $(compgen -W "--output --no-apply --no-advice --source --set --yes" -- "${cur}") )
      ;;
    apply)
      COMPREPLY=( $(compgen -W "--wizard --no-advice --yes --checkpoint --source --set" -- "${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--global" -- "${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    destroy)
      COMPREPLY=( $(compgen -W "--yes --all --include-iam --dry-run" -- "${cur}") )
      ;;
    drift)
      COMPREPLY=( $(compgen -W "--resource --region --status --exclude --baseline --json --output --concurrency --no-color --verbose --yes" -- "${cur}") )
      ;;
    optimize)
      COMPREPLY=( $(compgen -W "--region --json --reconcile --min-savings --no-color" -- "${cur}") )
      ;;
    list)
      COMPREPLY=( $(compgen -W "--json --region --total-cost" -- "${cur}") )
      ;;
    setup)
      COMPREPLY=( $(compgen -W "--profile --yes --enable-llm-logging --disable-llm-logging --dry-run" -- "${cur}") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--json --region --bp-coverage --gaps-only --include-structural-gaps" -- "${cur}") )
      ;;
    clean)
      COMPREPLY=( $(compgen -W "--dry-run --confirm --yes --checkpoints --cache --memory --resources --logs --baselines --json" -- "${cur}") )
      ;;
    reconcile)
      COMPREPLY=( $(compgen -W "--resource --dry-run --auto-reconcile --yes" -- "${cur}") )
      ;;
    cache)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--json --skip-bedrock --skip-mcp --skip-mcp-version-check" -- "${cur}") )
      ;;
    whoami)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    patterns)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
    types)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
  esac
  return 0
}

complete -F _assignee_completions assignee
