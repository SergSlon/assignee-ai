import { Command } from 'commander'

export const planCommand = new Command('plan')
  .description('Generate an infrastructure plan from natural language')
  .argument('[intent]', 'Natural language description of desired infrastructure')
  .option('-o, --output <format>', 'Output format (json|text)', 'text')
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.log('Usage: assignee plan "Create an S3 bucket named my-bucket"')
      return
    }
    console.log(`[plan stub] Intent: "${intent}"`)
    console.log('[plan stub] Plan generation will be implemented in Story 1.6')
  })
