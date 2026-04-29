#!/usr/bin/env node

/**
 * CLI entry point for prodgate.
 *
 * Commands:
 *   prodgate diff <before> <after>   Diff access control model between two repo versions
 *
 * Flags:
 *   --json           Output raw JSON
 *   --github         Output GitHub markdown for PR comments
 *   --output <file>  Write output to a file
 *   --strict         Fail CI on warnings as well as criticals
 */

import { Command } from 'commander'
import * as fs from 'fs'
import { scanRepo } from './extract'
import { diffRoutes } from './diff'
import { formatHuman, formatGithub } from './output'

const program = new Command()

program
  .name('prodgate')
  .description('Access control regression detection for Express APIs')
  .version('0.1.0')

program
  .command('diff <before> <after>')
  .description('Diff access control model between two versions of a repo')
  .option('--json', 'Output raw JSON')
  .option('--github', 'Output GitHub-flavored markdown for PR comments')
  .option('--output <file>', 'Write output to a file')
  .option('--strict', 'Fail CI on warnings as well as criticals')
  .action(async (before: string, after: string, options) => {
    const beforeRoutes = await scanRepo(before)
    const afterRoutes = await scanRepo(after)
    const result = diffRoutes(beforeRoutes, afterRoutes)

    let output: string

    if (options.json) {
      output = JSON.stringify(result, null, 2)
    } else if (options.github) {
      output = formatGithub(result)
    } else {
      output = formatHuman(result)
    }

    if (options.output) {
      fs.writeFileSync(options.output, output)
    } else {
      console.log(output)
    }

    const shouldFail = result.verdict === 'fail' ||
      (options.strict && result.stats.warningCount > 0)

    if (shouldFail) {
      process.exit(1)
    }
  })

program.parse()