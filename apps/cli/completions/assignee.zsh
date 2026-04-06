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
      esac
      ;;
  esac
}

_assignee
