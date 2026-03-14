import { Command } from 'commander'
import { CommandName, CommandDescription, CommandArgs, CommandOptions } from '../constants/commands.js'

export const applyCommand = new Command(CommandName.APPLY)
  .description(CommandDescription.APPLY)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option(CommandOptions.DRY_RUN.FLAGS, CommandOptions.DRY_RUN.DESC)
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.log('Usage: assignee apply "Create an S3 bucket named my-bucket"')
      return
    }
    console.log(`[apply stub] Intent: "${intent}"`)
    console.log('[apply stub] Apply execution will be implemented in Story 2.6')
  })
