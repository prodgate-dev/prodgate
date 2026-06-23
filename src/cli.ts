#!/usr/bin/env node
/**
 * cli.ts
 *
 * CLI entry point for prodgate.
 *
 *   prodgate check <plan.json>
 *
 * Reads a Terraform/OpenTofu plan in JSON form (`terraform show -json plan.tfplan`)
 * and blocks destructive or dangerous changes to production. Prodgate never runs
 * terraform and never needs cloud credentials: it only reads the plan file.
 *
 * Exit codes: 0 pass, 1 fail (gate triggered), 2 usage/plan error.
 */

import { Command } from 'commander'
import * as fs from 'fs'
import { parsePlan } from './plan'
import { detectAgent, AgentMetadata } from './agent'
import { classifyPlan, Config } from './classify'
import { formatHuman, formatGithub } from './output'

const program = new Command()

program
  .name('prodgate')
  .description('Block destructive infrastructure changes in CI before they ship')
  .version(require('../package.json').version)

program
  .command('check')
  .description('Check a Terraform/OpenTofu plan (JSON) for destructive or dangerous changes')
  .argument('<plan>', 'Path to a `terraform show -json` plan file')
  .option('--json', 'Output raw JSON')
  .option('--github', 'Output GitHub-flavored markdown for PR comments')
  .option('--output <file>', 'Write output to a file')
  .option('--strict', 'Also fail on warnings')
  .option('--approved', 'Treat the change as human-approved (gate passes; findings still reported)')
  .option('--config <file>', 'Path to prodgate.config.json')
  .option('--pr-author <author>', 'PR author login (for agent detection)')
  .option('--branch <branch>', 'Head branch name (for agent detection)')
  .option('--commits-file <file>', 'File of commit messages (for agent detection)')
  .option('--pr-body-file <file>', 'File containing the PR body (for agent detection)')
  .action((planPath, options) => {
    if (!fs.existsSync(planPath)) {
      console.error(`Plan file not found: ${planPath}`)
      process.exit(2)
    }

    let changes
    try {
      changes = parsePlan(readTextFile(planPath))
    } catch (e) {
      console.error((e as Error).message)
      process.exit(2)
    }

    const meta: AgentMetadata = {
      author: options.prAuthor ?? process.env.PRODGATE_PR_AUTHOR,
      branch: options.branch ?? process.env.PRODGATE_BRANCH,
      commitMessages: readMaybe(options.commitsFile) ?? process.env.PRODGATE_COMMITS,
      prBody: readMaybe(options.prBodyFile) ?? process.env.PRODGATE_PR_BODY,
    }
    const agent = detectAgent(meta)
    const approved = !!options.approved || process.env.PRODGATE_APPROVED === 'true'
    const config = loadConfig(options.config)

    const result = classifyPlan(changes, { agent, approved, strict: !!options.strict, config })

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

    if (result.verdict === 'fail') {
      process.exit(1)
    }
  })

program.parse()

// Read a text file, honoring a UTF-16 byte-order mark. PowerShell's `>` and
// `Out-File` emit UTF-16 LE (5.1) or UTF-8 with a BOM, so a plan piped from
// `terraform show -json > plan.json` on Windows is commonly not plain UTF-8.
function readTextFile(p: string): string {
  const buf = fs.readFileSync(p)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf) // utf16be -> swap to utf16le for Node
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t
    }
    return swapped.toString('utf16le')
  }
  return buf.toString('utf8') // a UTF-8 BOM, if present, is stripped in parsePlan
}

function readMaybe(p?: string): string | undefined {
  try {
    return p ? readTextFile(p) : undefined
  } catch {
    return undefined
  }
}

function loadConfig(p?: string): Config | undefined {
  const target = p ?? 'prodgate.config.json'
  try {
    if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    /* ignore malformed config; zero-config is the default */
  }
  return undefined
}
