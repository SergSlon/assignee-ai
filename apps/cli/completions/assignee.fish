# Fish completion script for assignee
# Generated automatically from the Commander.js command tree.
# Install: assignee completions fish | source
#   or save to ~/.config/fish/completions/assignee.fish

complete -c assignee -f

complete -c assignee -n __fish_use_subcommand -a plan -d 'Generate an infrastructure plan from natural language intent'
complete -c assignee -n __fish_use_subcommand -a apply -d 'Execute an approved infrastructure plan'
complete -c assignee -n __fish_use_subcommand -a init -d 'Initialize assignee.ai project configuration'
complete -c assignee -n __fish_use_subcommand -a completions -d 'Output shell completion script'

# Options for 'plan'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l output -s o -r -d 'Output format (json|text)'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l no-apply -d 'Skip the apply prompt after plan display'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l no-advice -d 'Skip inline contextual advice generation'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l source -s s -r -d 'Path to local files to upload after provisioning (e.g., static site)'
complete -c assignee -n "__fish_seen_subcommand_from plan" -l set -r -d 'Pre-set field values, supports human names (e.g., --set size=t3.medium)'

# Options for 'apply'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l wizard -d 'Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l no-advice -d 'Skip inline contextual advice generation'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l yes -s y -d 'Auto-confirm apply without interactive prompt (for CI/CD)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l checkpoint -s c -r -d 'Use a saved plan checkpoint instead of running Phase 1'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l source -s s -r -d 'Path to local files to upload after provisioning (e.g., static site)'
complete -c assignee -n "__fish_seen_subcommand_from apply" -l set -r -d 'Pre-set wizard field values (repeatable)'

# Options for 'init'
complete -c assignee -n "__fish_seen_subcommand_from init" -l global -d 'Create global user config (~/.config/assignee/config.yaml) instead of project config'
