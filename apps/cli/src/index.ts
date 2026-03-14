#!/usr/bin/env node
import { Command } from 'commander'
import { planCommand } from './commands/plan.js'
import { applyCommand } from './commands/apply.js'

const program = new Command()

program
  .name('assignee')
  .description('Assignee.ai — AI-Native Cloud Operator')
  .version('0.1.0')

program.addCommand(planCommand)
program.addCommand(applyCommand)

program.parseAsync(process.argv)
