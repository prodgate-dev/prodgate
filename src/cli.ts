#!/usr/bin/env node
/**
 * cli.ts
 *
 * CLI entry point for prodgate.
 *
 * Commands:
 *   prodgate check --before <path> --after <path>
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
  .version(require('../package.json').version)

program
  .command('check')
  .description('Check for access control regressions between two versions of a repo')
  .requiredOption('--before <path>', 'Path to the base version of the repo')
  .requiredOption('--after <path>', 'Path to the changed version of the repo')
  .option('--json', 'Output raw JSON')
  .option('--github', 'Output GitHub-flavored markdown for PR comments')
  .option('--output <file>', 'Write output to a file')
  .option('--strict', 'Fail CI on warnings as well as criticals')
  .action(async (options) => {
    const beforeResult = await scanRepo(options.before)
    const afterResult = await scanRepo(options.after)

    const ignorePaths = [
      ...(beforeResult.config.ignore ?? []),
      ...(afterResult.config.ignore ?? [])
    ]

    const result = diffRoutes(
      beforeResult.routes,
      afterResult.routes,
      beforeResult.mounts,
      afterResult.mounts,
      ignorePaths
    )

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