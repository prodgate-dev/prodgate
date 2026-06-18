/**
 * output.ts
 *
 * Formats a PlanResult for humans and for GitHub PR comments. Mutation-led: it
 * leads with the irreversible/dangerous changes and never buries the signal.
 * House style: no em-dashes (colon-separated).
 */

import { PlanResult, PlanFinding } from './classify'

const BAR = '─'.repeat(50)

function actionVerb(f: PlanFinding): string {
  return f.action.toUpperCase()
}

function humanLine(f: PlanFinding): string {
  const action = actionVerb(f).padEnd(8)
  const address = f.resource.address.padEnd(34)
  return `  ${action} ${address} ${f.summary}`
}

export function formatHuman(result: PlanResult): string {
  const lines: string[] = []
  const s = result.stats
  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')

  lines.push('')
  lines.push('Prodgate Infrastructure Change Report')
  lines.push(BAR)
  lines.push(`Resources scanned: ${s.resourcesScanned}`)

  if (criticals.length > 0) {
    lines.push('')
    lines.push(`[CRITICAL] ${criticals.length} destructive or dangerous change${criticals.length > 1 ? 's' : ''}`)
    lines.push('')
    for (const f of criticals) lines.push(humanLine(f))
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push(`[WARNING] ${warnings.length} change${warnings.length > 1 ? 's' : ''} to review`)
    lines.push('')
    for (const f of warnings) lines.push(humanLine(f))
  }

  if (result.findings.length === 0) {
    lines.push('')
    lines.push('No destructive or dangerous changes detected.')
  }

  if (result.agent.likelyAgent) {
    lines.push('')
    lines.push('[AI-AGENT] This plan appears to be agent-generated.')
    for (const sig of result.agent.signals) lines.push(`           ${sig}`)
  }

  if (result.approved && (criticals.length > 0 || warnings.length > 0)) {
    lines.push('')
    lines.push('[APPROVED] A human approved these changes; the gate is passing.')
  }

  lines.push('')
  lines.push(BAR)
  const verdict = result.verdict === 'pass' ? 'PASS' : 'FAIL'
  lines.push(`Verdict: ${verdict}${result.approved && result.verdict === 'pass' && (criticals.length || warnings.length) ? ' (approved)' : ''}`)
  lines.push('')
  return lines.join('\n')
}

export function formatGithub(result: PlanResult): string {
  const lines: string[] = []
  const s = result.stats
  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')
  const verdict = result.verdict === 'pass' ? 'PASS' : 'FAIL'

  lines.push(`## Prodgate Infrastructure Change Check: ${verdict}`)
  lines.push('')
  lines.push(`**${s.resourcesScanned} resources scanned.** ${s.criticalCount} critical, ${s.warningCount} warning.`)

  if (result.agent.likelyAgent) {
    lines.push('')
    lines.push(`> :robot: This plan appears to be **AI-agent generated** (${result.agent.signals[0]}).`)
  }

  if (criticals.length > 0) {
    lines.push('')
    lines.push(`### Critical (${criticals.length})`)
    for (const f of criticals) {
      lines.push(`- \`${f.resource.address}\` (${f.action}): ${f.summary}`)
    }
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push(`### Warnings (${warnings.length})`)
    for (const f of warnings) {
      lines.push(`- \`${f.resource.address}\` (${f.action}): ${f.summary}`)
    }
  }

  if (result.findings.length === 0) {
    lines.push('')
    lines.push('No destructive or dangerous changes detected.')
  }

  if (result.approved && result.findings.length > 0) {
    lines.push('')
    lines.push('A human approved these changes via the `prodgate-approved` label; the gate is passing.')
  } else if (criticals.length > 0) {
    lines.push('')
    lines.push('Add the `prodgate-approved` label to approve these changes and pass the gate.')
  }

  return lines.join('\n')
}
