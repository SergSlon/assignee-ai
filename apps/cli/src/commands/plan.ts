import { Command } from 'commander'
import { CommandName, CommandDescription, CommandArgs } from '../constants/commands.js'

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option('-o, --output <format>', 'Output format (json|text)', 'text')
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.log('Usage: assignee plan "Create an S3 bucket named my-bucket"')
      return
    }
    console.log(`[plan stub] Intent: "${intent}"`)
    console.log('[plan stub] Plan generation will be implemented in Story 1.6')
  })
