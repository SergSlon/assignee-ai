# Bash completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: eval "$(assignee completions bash)" or add to ~/.bashrc

_assignee_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="plan apply init completions"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return 0
  fi

  local command="${COMP_WORDS[1]}"
  case "${command}" in
    plan)
      COMPREPLY=( $(compgen -W "--output --no-apply --set" -- "${cur}") )
      ;;
    apply)
      COMPREPLY=( $(compgen -W "--no-wizard --yes --checkpoint --set" -- "${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--global" -- "${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "" -- "${cur}") )
      ;;
  esac
  return 0
}

complete -F _assignee_completions assignee
