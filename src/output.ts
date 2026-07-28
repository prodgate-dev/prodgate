/**
 * output.ts
 *
 * Formats a PlanResult for humans and for GitHub PR comments. It opens with a
 * one-line plan summary so the check is useful on every PR, then leads with the
 * destructive or dangerous changes and never buries the signal.
 */

import { PlanResult, PlanFinding, OverrideInfo } from './classify'

const BAR = '─'.repeat(50)

// Describe an applied override from its mechanism and metadata. Never call the
// triggering actor an approver.
function overrideHeadline(o: OverrideInfo): string {
  if (o.mechanism === 'github_label') return 'Manual GitHub label override applied.'
  if (o.mechanism === 'manual') return 'Manual CLI override applied.'
  return 'Manual override applied.'
}
function overrideDetails(o: OverrideInfo): string[] {
  const d: string[] = []
  if (o.mechanism === 'github_label' && o.label) d.push(`Label: ${o.label}`)
  if (o.workflowActor) d.push(`Triggered by: @${o.workflowActor}`)
  if (o.headSha) d.push(`PR head: ${o.headSha}`)
  return d
}

type Paint = (s: string) => string
type Palette = { red: Paint; yellow: Paint; green: Paint }

// ANSI color for the terminal report only. Disabled by default; the caller turns
// it on for a TTY. The GitHub and JSON outputs are never colored.
function palette(on: boolean): Palette {
  if (!on) {
    const plain: Paint = s => s
    return { red: plain, yellow: plain, green: plain }
  }
  const wrap = (code: string): Paint => s => `\x1b[${code}m${s}\x1b[0m`
  return { red: wrap('1;31'), yellow: wrap('1;33'), green: wrap('1;32') }
}

// One-line tally of what the plan does, in Terraform's own add/change/destroy
// phrasing. The replace segment only appears when there is something to replace,
// so a clean plan stays short.
function planSummary(result: PlanResult): string {
  const s = result.stats
  const parts = [`${s.created} to add`, `${s.updated} to change`]
  if (s.replaced > 0) parts.push(`${s.replaced} to replace`)
  parts.push(`${s.destroyed} to destroy`)
  return parts.join(', ')
}

// A plain note that a replace or removal affects availability. Informational only.
function disruptionPhrase(x: { address: string; action: 'replace' | 'delete' }): string {
  return x.action === 'delete'
    ? `removing \`${x.address}\` affects availability`
    : `replacing \`${x.address}\` briefly interrupts service while it is recreated`
}
function disruptionNote(result: PlanResult): string | null {
  const d = result.disruptions
  if (d.length === 0) return null
  if (d.length === 1) {
    const p = disruptionPhrase(d[0])
    return 'Availability: ' + p.charAt(0).toUpperCase() + p.slice(1) + '.'
  }
  const shown = d.slice(0, 5).map(disruptionPhrase)
  const suffix = d.length > 5 ? `, and ${d.length - 5} more` : ''
  return `Availability: ${shown.join('; ')}${suffix}.`
}

// Plain lines noting destructions that a configured exception allowed through.
function suppressionNotes(result: PlanResult): string[] {
  return result.suppressions.map(s =>
    s.matchedBy
      ? `Destruction of \`${s.address}\` allowed by exception \`${s.matchedBy}\`.`
      : `Destruction of \`${s.address}\` allowed by an exception.`)
}

// In audit mode a would-be block does not fail the build, so the report must say so
// conspicuously rather than read as a plain pass.
function auditBannerText(result: PlanResult): string | null {
  return result.enforcementMode === 'audit' && result.wouldBlock
    ? 'AUDIT MODE: this plan would have been blocked in enforcement mode.'
    : null
}

function actionVerb(f: PlanFinding): string {
  return f.action.toUpperCase()
}

function humanLine(f: PlanFinding): string {
  const action = actionVerb(f).padEnd(8)
  const address = f.resource.address.padEnd(34)
  return `  ${action} ${address} ${f.summary}`
}

export function formatHuman(result: PlanResult, opts: { color?: boolean } = {}): string {
  const c = palette(!!opts.color)
  const lines: string[] = []
  const s = result.stats
  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')

  lines.push('')
  lines.push('Prodgate Infrastructure Change Report')
  lines.push(BAR)
  lines.push(`Resources scanned: ${s.resourcesScanned}`)
  lines.push(`Plan summary: ${planSummary(result)}`)

  const humanBanner = auditBannerText(result)
  if (humanBanner) {
    lines.push('')
    lines.push(c.yellow('[AUDIT MODE] ' + humanBanner.replace(/^AUDIT MODE: /, '')))
  }

  if (criticals.length > 0) {
    lines.push('')
    lines.push(c.red(`[CRITICAL] ${criticals.length} destructive or dangerous change${criticals.length > 1 ? 's' : ''}`))
    lines.push('')
    for (const f of criticals) lines.push(humanLine(f))
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push(c.yellow(`[WARNING] ${warnings.length} change${warnings.length > 1 ? 's' : ''} to review`))
    lines.push('')
    for (const f of warnings) lines.push(humanLine(f))
  }

  if (result.findings.length === 0) {
    lines.push('')
    lines.push(result.stats.resourcesScanned === 0
      ? 'Valid plan: no managed resource changes.'
      : 'No destructive or dangerous changes detected.')
  }

  const humanDisruption = disruptionNote(result)
  if (humanDisruption) {
    lines.push('')
    lines.push(humanDisruption)
  }

  for (const note of suppressionNotes(result)) {
    lines.push('')
    lines.push(note)
  }

  if (result.agent.likelyAgent) {
    lines.push('')
    lines.push('[AI-AGENT] This plan appears to be generated by an AI agent.')
    for (const sig of result.agent.signals) lines.push(`           ${sig}`)
  }

  if (result.overrideApplied && result.override) {
    lines.push('')
    lines.push('[OVERRIDE] ' + overrideHeadline(result.override))
    for (const d of overrideDetails(result.override)) lines.push('           ' + d)
    lines.push('           Findings remain recorded, but the gate is passing.')
  }

  lines.push('')
  lines.push(BAR)
  const verdict = auditBannerText(result)
    ? c.yellow('AUDIT (would block)')
    : result.verdict === 'pass' ? c.green('PASS') : c.red('FAIL')
  lines.push(`Verdict: ${verdict}${result.overrideApplied && result.verdict === 'pass' && (criticals.length || warnings.length) ? ' (override)' : ''}`)
  lines.push(`Mode: ${result.enforcementMode}, fail-on: ${result.failOn}`)
  if (result.configPath) lines.push(`Config: ${result.configPath}`)
  if (result.planHash) lines.push(`Plan hash: ${result.planHash}`)
  if (result.policyDigest) lines.push(`Policy digest: ${result.policyDigest}`)
  lines.push('')
  return lines.join('\n')
}

export function formatGithub(result: PlanResult): string {
  const lines: string[] = []
  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')
  const banner = auditBannerText(result)
  const headline = banner ? 'AUDIT — would block' : result.verdict === 'pass' ? 'PASS' : 'FAIL'

  lines.push(`## Prodgate Infrastructure Change Check: ${headline}`)
  lines.push('')
  lines.push(`**Plan summary:** ${planSummary(result)}.`)

  if (banner) {
    lines.push('')
    lines.push(`> **${banner}**`)
  }

  if (result.agent.likelyAgent) {
    lines.push('')
    lines.push(`> This plan appears to be generated by an AI agent (${result.agent.signals[0]}).`)
  }

  if (criticals.length > 0) {
    lines.push('')
    lines.push(`### Critical (${criticals.length})`)
    for (const f of criticals) lines.push(...githubFinding(f))
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push(`### Warnings (${warnings.length})`)
    for (const f of warnings) lines.push(...githubFinding(f))
  }

  if (result.findings.length === 0) {
    lines.push('')
    lines.push(result.stats.resourcesScanned === 0
      ? 'Valid plan: no managed resource changes.'
      : 'No destructive or dangerous changes detected.')
  }

  const githubDisruption = disruptionNote(result)
  if (githubDisruption) {
    lines.push('')
    lines.push(githubDisruption)
  }

  for (const note of suppressionNotes(result)) {
    lines.push('')
    lines.push(note)
  }

  if (result.overrideApplied && result.override) {
    const o = result.override
    const bits: string[] = [overrideHeadline(o)]
    if (o.mechanism === 'github_label' && o.label) bits.push(`label \`${o.label}\``)
    if (o.workflowActor) bits.push(`triggered by \`@${o.workflowActor}\``)
    if (o.headSha) bits.push(`PR head \`${o.headSha}\``)
    lines.push('')
    lines.push(`**Override:** ${bits.join(', ')}. Findings remain recorded, but the gate is passing.`)
  } else if (criticals.length > 0) {
    lines.push('')
    lines.push('To override: add the `prodgate-approved` label to this PR.')
  }

  const footer: string[] = [`mode: ${result.enforcementMode}`, `fail-on: ${result.failOn}`]
  if (result.planHash) footer.push(`plan hash: \`${result.planHash}\``)
  if (result.policyDigest) footer.push(`policy digest: \`${result.policyDigest}\``)
  lines.push('')
  lines.push(`<sub>${footer.join(' | ')}</sub>`)

  return lines.join('\n')
}

// A scannable per-finding block: action + resource on the lead line, the reason
// indented beneath it.
function githubFinding(f: PlanFinding): string[] {
  return [`- **${f.action.toUpperCase()}** \`${f.resource.address}\` (${f.ruleId})`, `  Why: ${f.reason}`]
}
