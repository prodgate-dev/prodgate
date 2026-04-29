import { DiffResult, DiffEntry } from './diff'

function formatEntry(entry: DiffEntry): string {
  const lines: string[] = []

  const prefix = entry.severity === 'CRITICAL' ? '[CRITICAL]' : entry.severity === 'WARNING' ? '[WARNING] ' : '[INFO]    '
  lines.push(`${prefix} ${entry.message}`)

  if (entry.before !== undefined && entry.after !== undefined) {
    const beforeChain = entry.before.length > 0 ? entry.before.join(' -> ') : '(none)'
    const afterChain = entry.after.length > 0 ? entry.after.join(' -> ') : '(none)'
    lines.push(`           Before: ${beforeChain}`)
    lines.push(`           After:  ${afterChain}`)
  }

  return lines.join('\n')
}

export function formatHuman(result: DiffResult): string {
  const lines: string[] = []

  lines.push(``)
  lines.push(`Prodgate Access Control Report`)
  lines.push(`${'─'.repeat(50)}`)
  lines.push(`Routes scanned: ${result.stats.routesScanned}`)

  if (result.entries.length === 0) {
    lines.push(``)
    lines.push(`No access control issues detected.`)
    lines.push(``)
    lines.push(`${'─'.repeat(50)}`)
    lines.push(`Verdict: PASS`)
    lines.push(``)
    return lines.join('\n')
  }

  const criticals = result.entries.filter(e => e.severity === 'CRITICAL')
  const warnings = result.entries.filter(e => e.severity === 'WARNING')
  const infos = result.entries.filter(e => e.severity === 'INFO')

  if (criticals.length > 0) {
    lines.push(``)
    for (const entry of criticals) {
      lines.push(formatEntry(entry))
    }
  }

  if (warnings.length > 0) {
    lines.push(``)
    for (const entry of warnings) {
      lines.push(formatEntry(entry))
    }
  }

  if (infos.length > 0) {
    lines.push(``)
    for (const entry of infos) {
      lines.push(formatEntry(entry))
    }
  }

  lines.push(``)
  lines.push(`${'─'.repeat(50)}`)

  const summaryParts = []
  if (result.stats.criticalCount > 0) summaryParts.push(`${result.stats.criticalCount} critical`)
  if (result.stats.warningCount > 0) summaryParts.push(`${result.stats.warningCount} warning`)
  if (result.stats.infoCount > 0) summaryParts.push(`${result.stats.infoCount} info`)

  lines.push(`Summary: ${summaryParts.join(', ')}`)
  lines.push(`Verdict: ${result.verdict === 'pass' ? 'PASS' : 'FAIL'}`)
  lines.push(``)

  return lines.join('\n')
}

export function formatGithub(result: DiffResult): string {
  const lines: string[] = []

  const verdict = result.verdict === 'pass' ? 'PASS' : 'FAIL'
  lines.push(`## Prodgate Access Control Check: ${verdict}`)
  lines.push(``)
  lines.push(`**${result.stats.routesScanned} routes scanned**`)

  if (result.entries.length === 0) {
    lines.push(``)
    lines.push(`No access control issues detected.`)
    return lines.join('\n')
  }

  const criticals = result.entries.filter(e => e.severity === 'CRITICAL')
  const warnings = result.entries.filter(e => e.severity === 'WARNING')
  const infos = result.entries.filter(e => e.severity === 'INFO')

  if (criticals.length > 0) {
    lines.push(``)
    lines.push(`### Critical Issues`)
    for (const entry of criticals) {
      lines.push(``)
      lines.push(`**\`${entry.route.method.toUpperCase()} ${entry.route.path}\`** — ${entry.message}`)
      if (entry.before !== undefined && entry.after !== undefined) {
        lines.push(`- Before: \`${entry.before.join(' -> ') || '(none)'}\``)
        lines.push(`- After:  \`${entry.after.join(' -> ') || '(none)'}\``)
      }
    }
  }

  if (warnings.length > 0) {
    lines.push(``)
    lines.push(`### Warnings`)
    for (const entry of warnings) {
      lines.push(`- \`${entry.route.method.toUpperCase()} ${entry.route.path}\` — ${entry.message}`)
    }
  }

  if (infos.length > 0) {
    lines.push(``)
    lines.push(`### Info`)
    for (const entry of infos) {
      lines.push(`- ${entry.message}`)
    }
  }

  return lines.join('\n')
}