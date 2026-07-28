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
import * as crypto from 'crypto'
import { parsePlanFull } from './plan'
import { detectAgent, AgentMetadata } from './agent'
import { classifyPlan, Config, EnforcementMode, FailOn, PlanResult } from './classify'
import { POLICY_VERSION } from './resources'
import { formatHuman, formatGithub } from './output'

const ENGINE_VERSION: string = require('../package.json').version

// Set once per run so config errors can be emitted as JSON alongside plan-input
// errors. Declared before program.parse so it is initialized when the action runs.
let emitErrorsAsJson = false

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
  .option('--outputs-file <file>', 'Append key=value CI outputs to this file (used by the Action)')
  .option('--mode <mode>', 'Enforcement mode: audit or enforce (default enforce)')
  .option('--fail-on <level>', 'Block on: critical, warning, or never (default critical)')
  .option('--strict', 'Deprecated alias for --fail-on warning')
  .option('--color', 'Force ANSI color in the report even when output is not a terminal')
  .option('--override', 'Record a manual override (gate passes; findings still reported)')
  .option('--approved', 'Deprecated alias for --override')
  .option('--config <file>', 'Path to prodgate.config.json')
  .option('--pr-author <author>', 'PR author login (for agent detection)')
  .option('--branch <branch>', 'Head branch name (for agent detection)')
  .option('--commits-file <file>', 'File of commit messages (for agent detection)')
  .option('--pr-body-file <file>', 'File containing the PR body (for agent detection)')
  .action((planPath, options) => {
    emitErrorsAsJson = !!options.json
    if (!fs.existsSync(planPath)) {
      if (options.json) {
        console.log(JSON.stringify({ error: { code: 'PLAN_NOT_FOUND', message: `Plan file not found: ${planPath}` } }, null, 2))
      } else {
        console.error(`Plan file not found: ${planPath}`)
      }
      process.exit(2)
    }

    let changes
    let planHash: string
    let planMeta: { formatVersion?: string; terraformVersion?: string } = {}
    try {
      const text = readTextFile(planPath)
      // Hash the BOM-stripped text so the same logical plan hashes identically
      // regardless of encoding. Approvals can later be tied to this hash.
      const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      planHash = 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex')
      const parsed = parsePlanFull(text)
      changes = parsed.changes
      planMeta = { formatVersion: parsed.formatVersion, terraformVersion: parsed.terraformVersion }
    } catch (e) {
      const err = e as { code?: string; message: string; path?: string }
      if (options.json) {
        console.log(JSON.stringify({ error: { code: err.code ?? 'INVALID_INPUT', message: err.message, path: err.path } }, null, 2))
      } else {
        console.error(err.message)
      }
      process.exit(2)
    }

    const meta: AgentMetadata = {
      author: options.prAuthor ?? process.env.PRODGATE_PR_AUTHOR,
      branch: options.branch ?? process.env.PRODGATE_BRANCH,
      commitMessages: readMaybe(options.commitsFile) ?? process.env.PRODGATE_COMMITS,
      prBody: readMaybe(options.prBodyFile) ?? process.env.PRODGATE_PR_BODY,
    }
    const agent = detectAgent(meta)
    const envOverride = process.env.PRODGATE_OVERRIDE === 'true' || process.env.PRODGATE_APPROVED === 'true'
    const flagOverride = !!options.override || !!options.approved
    const override = envOverride || flagOverride
      ? {
          applied: true,
          mechanism: envOverride ? 'github_label' : 'manual',
          label: envOverride ? (process.env.PRODGATE_OVERRIDE_LABEL || 'prodgate-approved') : undefined,
          workflowActor: process.env.PRODGATE_OVERRIDE_ACTOR || undefined,
          headSha: process.env.PRODGATE_COMMIT_SHA || undefined,
        }
      : undefined
    const config = loadConfig(options.config)
    const configPath = config ? (options.config ?? 'prodgate.config.json') : undefined

    // Effective mode/failOn: an explicit flag wins over the config file, which wins
    // over the defaults. Enforce and critical are the defaults, so the gate gates.
    const mode = resolveMode(options.mode, config)
    const failOn = resolveFailOn(options.failOn, !!options.strict, config)
    const policyDigest = computePolicyDigest(mode, failOn, config)

    const result = classifyPlan(changes, { agent, override, mode, failOn, config, planHash, configPath, policyDigest })

    // Color the terminal report only, and never the GitHub or JSON output. Default
    // to a TTY that is not being redirected to a file; NO_COLOR disables it, and
    // --color forces it on (used to capture the demo recording).
    const useColor = !!options.color || (!process.env.NO_COLOR && !!process.stdout.isTTY && !options.output)

    let output: string
    if (options.json) {
      output = JSON.stringify(buildEnvelope(result, planMeta), null, 2)
    } else if (options.github) {
      output = formatGithub(result)
    } else {
      output = formatHuman(result, { color: useColor })
    }

    if (options.output) {
      fs.writeFileSync(options.output, output)
    } else {
      console.log(output)
    }

    if (options.outputsFile) {
      writeOutputs(options.outputsFile, result, options.output)
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

function configError(message: string): never {
  if (emitErrorsAsJson) {
    console.log(JSON.stringify({ error: { code: 'INVALID_CONFIG', message } }, null, 2))
  } else {
    console.error('Invalid prodgate config: ' + message)
  }
  process.exit(2)
}

function isNonEmptyStringArray(v: any): boolean {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim().length > 0)
}

// Config is validated rather than silently ignored: a malformed config file almost
// always means the user meant to change behavior, so failing closed is safer than
// quietly running the defaults.
function loadConfig(p?: string): Config | undefined {
  const explicit = !!p
  const target = p ?? 'prodgate.config.json'
  if (!fs.existsSync(target)) {
    if (explicit) configError(`config file not found: ${target}`)
    return undefined
  }
  let raw: any
  try {
    let text = fs.readFileSync(target, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    raw = JSON.parse(text)
  } catch (e) {
    configError(`${target} is not valid JSON: ${(e as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) configError(`${target}: root must be an object`)
  const supportedKeys = new Set(['schemaVersion', 'mode', 'failOn', 'ignore', 'allowDestruction', 'allowDestroy'])
  for (const k of Object.keys(raw)) {
    if (!supportedKeys.has(k)) configError(`${target}: unknown key "${k}"`)
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) configError(`${target}: unsupported schemaVersion (expected 1)`)
  if (raw.mode !== undefined && raw.mode !== 'audit' && raw.mode !== 'enforce') configError(`${target}: mode must be "audit" or "enforce"`)
  if (raw.failOn !== undefined && !['critical', 'warning', 'never'].includes(raw.failOn)) configError(`${target}: failOn must be "critical", "warning", or "never"`)
  for (const key of ['ignore', 'allowDestruction', 'allowDestroy']) {
    if (raw[key] !== undefined && !isNonEmptyStringArray(raw[key])) configError(`${target}: ${key} must be an array of non-empty strings`)
  }
  return raw as Config
}

function resolveMode(flag: string | undefined, config?: Config): EnforcementMode {
  const v = flag ?? config?.mode ?? 'enforce'
  if (v !== 'audit' && v !== 'enforce') {
    console.error(`Invalid --mode "${v}" (expected "audit" or "enforce").`)
    process.exit(2)
  }
  return v
}

function resolveFailOn(flag: string | undefined, strict: boolean, config?: Config): FailOn {
  const v = flag ?? config?.failOn ?? (strict ? 'warning' : 'critical')
  if (v !== 'critical' && v !== 'warning' && v !== 'never') {
    console.error(`Invalid --fail-on "${v}" (expected "critical", "warning", or "never").`)
    process.exit(2)
  }
  return v
}

// Sort object keys recursively so the digest depends on values, not key order or
// whitespace. Lets a future central policy be identified by the same digest.
function canonicalize(v: any): any {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k])
    return out
  }
  return v
}

function sortedUnique(arr?: string[]): string[] {
  return arr ? [...new Set(arr)].sort() : []
}

// Hash the effective policy, not the raw config: use the resolved mode and fail-on
// (so a CLI override matches an equivalent config), canonicalize the deprecated
// allowDestroy alias, and sort and de-duplicate pattern arrays so semantically equal
// policies share a digest.
function computePolicyDigest(mode: EnforcementMode, failOn: FailOn, config?: Config): string {
  const effective = {
    policyVersion: POLICY_VERSION,
    mode,
    failOn,
    ignore: sortedUnique(config?.ignore),
    allowDestruction: sortedUnique(config?.allowDestruction ?? config?.allowDestroy),
  }
  const json = JSON.stringify(canonicalize(effective))
  return 'sha256:' + crypto.createHash('sha256').update(json).digest('hex')
}

// Append key=value CI outputs so a GitHub Action can expose them. The Action points
// this at $GITHUB_OUTPUT; the format is the same key=value that GitHub expects.
function writeOutputs(file: string, result: PlanResult, reportPath?: string): void {
  const pairs: [string, string][] = [
    ['policy-verdict', result.policyVerdict],
    ['would-block', String(result.wouldBlock)],
    ['execution-outcome', result.executionOutcome],
    ['enforcement-mode', result.enforcementMode],
    ['exit-code', String(result.verdict === 'fail' ? 1 : 0)],
    ['critical-count', String(result.stats.criticalCount)],
    ['warning-count', String(result.stats.warningCount)],
    ['plan-hash', result.planHash ?? ''],
    ['policy-digest', result.policyDigest ?? ''],
    ['report-path', reportPath ?? ''],
    ['engine-version', ENGINE_VERSION],
  ]
  fs.appendFileSync(file, pairs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

// Source metadata, only when running inside GitHub Actions. Omitted for local runs.
function buildSource(): Record<string, unknown> | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true') return undefined
  const src: Record<string, unknown> = {}
  if (process.env.GITHUB_REPOSITORY) src.repository = process.env.GITHUB_REPOSITORY
  // Prefer the PR head SHA the Action passes; GITHUB_SHA is a synthetic merge commit
  // on pull_request events. Keep the workflow SHA too when they differ.
  const headSha = process.env.PRODGATE_COMMIT_SHA || process.env.GITHUB_SHA
  if (headSha) src.commitSha = headSha
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== headSha) src.workflowSha = process.env.GITHUB_SHA
  if (process.env.GITHUB_RUN_ID) src.workflowRunId = process.env.GITHUB_RUN_ID
  const pr = /refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')
  if (pr) src.pullRequest = Number(pr[1])
  return Object.keys(src).length ? src : undefined
}

// A stable, defined order for the envelope, independent of resource order in the
// plan: severity, then rule id, resource address, and action.
function sortFindings(findings: PlanResult['findings']): PlanResult['findings'] {
  const rank: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 }
  return [...findings].sort((a, b) =>
    (rank[a.severity] - rank[b.severity]) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.resource.address.localeCompare(b.resource.address) ||
    a.action.localeCompare(b.action))
}

// The stable, versioned evaluation envelope emitted by --json. It carries no raw
// plan values, keeps a deterministic finding order, and separates the policy verdict
// from the enforcement outcome.
function buildEnvelope(result: PlanResult, planMeta: { formatVersion?: string; terraformVersion?: string }) {
  const policy: Record<string, unknown> = { version: POLICY_VERSION, digest: result.policyDigest }
  if (result.configPath) policy.configPath = result.configPath
  const enforcement: Record<string, unknown> = {
    mode: result.enforcementMode,
    failOn: result.failOn,
    policyVerdict: result.policyVerdict,
    wouldBlock: result.wouldBlock,
    executionOutcome: result.executionOutcome,
  }
  if (result.override) enforcement.override = result.override
  const envelope: Record<string, unknown> = {
    schemaVersion: '1.0',
    engine: { name: 'prodgate', version: ENGINE_VERSION },
    policy,
    plan: { formatVersion: planMeta.formatVersion, terraformVersion: planMeta.terraformVersion, hash: result.planHash },
    enforcement,
    stats: result.stats,
    findings: sortFindings(result.findings),
    disruptions: result.disruptions,
    suppressions: result.suppressions,
  }
  const source = buildSource()
  if (source) envelope.source = source
  return envelope
}
