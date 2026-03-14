#!/usr/bin/env node
import { Command } from 'commander'
import { planCommand } from './commands/plan.js'
import { applyCommand } from './commands/apply.js'

import { closeMcpClient } from './services/mcp-client.js'

const program = new Command()

program
  .name('assignee')
  .description('Assignee.ai — AI-Native Cloud Operator')
  .version('0.1.0')

program.addCommand(planCommand)
program.addCommand(applyCommand)

// Graceful shutdown handlers for MCP servers
process.on('SIGINT', async () => {
  await closeMcpClient()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await closeMcpClient()
  process.exit(0)
})

program.parseAsync(process.argv)
