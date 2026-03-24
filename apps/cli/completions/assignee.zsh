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
      )
      _describe 'command' commands
      ;;
    args)
      case "${words[1]}" in
        plan)
          _arguments \
            '--output[Output format (json|text)]:format:' \
            '--no-apply[Skip the apply prompt after plan display]'
          ;;
        apply)
          _arguments \
            '--no-wizard[Skip interactive option prompts, use defaults]' \
            '--yes[Auto-confirm apply without interactive prompt (for CI/CD)]' \
            '--checkpoint[Use a saved plan checkpoint instead of running Phase 1]:path:'
          ;;
        init)
          _arguments \
            '--global[Create global user config (~/.config/assignee/config.yaml) instead of project config]'
          ;;
        completions)
          ;;
      esac
      ;;
  esac
}

_assignee
