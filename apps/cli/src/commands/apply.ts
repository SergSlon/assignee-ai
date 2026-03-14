import { Command } from 'commander'

export const applyCommand = new Command('apply')
  .description('Execute an approved infrastructure plan')
  .argument('[intent]', 'Natural language description of desired infrastructure')
  .option('--dry-run', 'Show what would be done without executing')
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.log('Usage: assignee apply "Create an S3 bucket named my-bucket"')
      return
    }
    console.log(`[apply stub] Intent: "${intent}"`)
    console.log('[apply stub] Apply execution will be implemented in Story 2.6')
  })
