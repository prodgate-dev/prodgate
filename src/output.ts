/**
 * output.ts
 *
 * Formats a DiffResult for human consumption.
 *
 * formatHuman: terminal-friendly output with severity prefixes,
 *              effective auth chains, and impact statements.
 * formatGithub: GitHub-flavored markdown for PR comment posting via Actions.
 */

import { DiffResult, Finding, canonicalizeMiddleware } from './diff'
import { ScanResult, ScannedRoute } from './scan'

function formatAuthChain(middlewares: string[]): string {
  if (middlewares.length === 0) return '(none)'
  return middlewares.map(canonicalizeMiddleware).join(' -> ')
}

function formatImpact(finding: Finding): string {
  const method = finding.route.method.toUpperCase()
  const routePath = finding.route.path

  switch (finding.deltaType) {
    case 'protected_to_unprotected':
      return `${method} ${routePath} no longer enforces any access control. This endpoint is now publicly accessible.`

    case 'privilege_weakened':
      const lost = finding.auth.removed.join(', ')
      return `${method} ${routePath} lost ${lost}. Access control is weaker than before.`

    case 'new_unprotected_route':
      return `${method} ${routePath} was added with no access control middleware.`

    case 'router_auth_removed':
      return `Routes under ${routePath} that relied on this mount guard are now reachable without authentication or authorization.`

    case 'shadowed_route':
      return `Express matches routes in order. The unprotected handler at ${routePath} will run before the protected one.`

    case 'inconsistent_with_siblings':
      return `Sibling routes on the same path prefix require auth but ${method} ${routePath} does not.`

    default:
      return ''
  }
}

function formatFilePath(file: string, line: number): string {
  const normalized = file.replace(/\\/g, '/')
  const match = normalized.match(/\/(src|api|routes|controllers|handlers)\/.+/)
  const relative = match ? match[0].slice(1) : normalized.split('/').pop() ?? normalized
  return line > 0 ? `${relative}:${line}` : relative
}

function formatFinding(finding: Finding): string {
  const lines: string[] = []
  const prefix = finding.severity === 'CRITICAL' ? '[CRITICAL]' : '[WARNING] '

  lines.push(`${prefix} ${finding.message}`)
  lines.push(``)
  lines.push(`  File:   ${formatFilePath(finding.route.file, finding.route.line)}`)

  if (finding.deltaType !== 'new_unprotected_route') {
    lines.push(`  Before: ${formatAuthChain(finding.auth.beforeEffective)}`)
    lines.push(`  After:  ${formatAuthChain(finding.auth.afterEffective)}`)
  } else {
    lines.push(`  Auth:   ${formatAuthChain(finding.auth.afterEffective)}`)
  }

  const impact = formatImpact(finding)
  if (impact) {
    lines.push(``)
    lines.push(`  Impact: ${impact}`)
  }

  if (finding.affectedRoutes && finding.affectedRoutes.length > 0) {
    lines.push(``)
    lines.push(`  Affected routes:`)
    for (const r of finding.affectedRoutes) {
      lines.push(`    ${r}`)
    }
  }

  if (finding.siblingContext && finding.siblingContext.length > 0) {
    lines.push(``)
    lines.push(`  Sibling routes requiring auth:`)
    for (const s of finding.siblingContext) {
      lines.push(`    ${s.method.toUpperCase()} ${s.path} -> ${formatAuthChain(s.middlewares)}`)
    }
  }

  return lines.join('\n')
}

export function formatHuman(result: DiffResult): string {
  const lines: string[] = []

  lines.push(``)
  lines.push(`Prodgate Access Control Report`)
  lines.push(`${'─'.repeat(50)}`)
  lines.push(`Routes scanned: ${result.stats.routesScanned}`)

  if (result.findings.length === 0) {
    lines.push(``)
    lines.push(`No access control issues detected.`)
    lines.push(``)
    lines.push(`${'─'.repeat(50)}`)
    lines.push(`Verdict: PASS`)
    lines.push(``)
    return lines.join('\n')
  }

  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')

  if (criticals.length > 0) {
    lines.push(``)
    for (const f of criticals) {
      lines.push(formatFinding(f))
      lines.push(``)
    }
  }

  if (warnings.length > 0) {
    for (const f of warnings) {
      lines.push(formatFinding(f))
      lines.push(``)
    }
  }

  lines.push(`${'─'.repeat(50)}`)

  // Route-centric summary
  lines.push(`Authorization changes detected:`)
  lines.push(``)

  if (criticals.length > 0) {
    lines.push(`  CRITICAL`)
    for (const f of criticals) {
      const before = formatAuthChain(f.auth.beforeEffective)
      const after = formatAuthChain(f.auth.afterEffective)
      const affected = f.affectedRoutes
        ? ` (${f.affectedRoutes.length} routes affected)`
        : ''
      if (f.deltaType === 'router_auth_removed') {
        lines.push(`    ${f.route.method.toUpperCase()} ${f.route.path}${affected}`)
      } else {
        lines.push(`    ${f.route.method.toUpperCase()} ${f.route.path}   ${before} -> ${after}`)
      }
    }
    lines.push(``)
  }

  if (warnings.length > 0) {
    lines.push(`  WARNING`)
    for (const f of warnings) {
      const before = formatAuthChain(f.auth.beforeEffective)
      const after = formatAuthChain(f.auth.afterEffective)
      lines.push(`    ${f.route.method.toUpperCase()} ${f.route.path}   ${before} -> ${after}`)
    }
    lines.push(``)
  }

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

  if (result.findings.length === 0) {
    lines.push(``)
    lines.push(`No access control issues detected.`)
    return lines.join('\n')
  }

  const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
  const warnings = result.findings.filter(f => f.severity === 'WARNING')

  if (criticals.length > 0) {
    lines.push(``)
    lines.push(`### Critical Issues`)
    for (const f of criticals) {
      lines.push(``)
      lines.push(`**\`${f.route.method.toUpperCase()} ${f.route.path}\`**: ${f.summary}`)
      lines.push(`- File: \`${formatFilePath(f.route.file, f.route.line)}\``)
      lines.push(`- Before: \`${formatAuthChain(f.auth.beforeEffective)}\``)
      lines.push(`- After: \`${formatAuthChain(f.auth.afterEffective)}\``)
      const impact = formatImpact(f)
      if (impact) lines.push(`- Impact: ${impact}`)
      if (f.affectedRoutes && f.affectedRoutes.length > 0) {
        lines.push(`- Affected routes: ${f.affectedRoutes.join(', ')}`)
      }
    }
  }

  if (warnings.length > 0) {
    lines.push(``)
    lines.push(`### Warnings`)
    for (const f of warnings) {
      lines.push(``)
      lines.push(`**\`${f.route.method.toUpperCase()} ${f.route.path}\`**: ${f.summary}`)
      lines.push(`- File: \`${formatFilePath(f.route.file, f.route.line)}\``)
      const impact = formatImpact(f)
      if (impact) lines.push(`- ${impact}`)
      if (f.siblingContext && f.siblingContext.length > 0) {
        lines.push(`- Protected siblings: ${f.siblingContext.map(s => `\`${s.method.toUpperCase()} ${s.path}\``).join(', ')}`)
      }
    }
  }

  return lines.join('\n')
}

// ─── scan output ───────────────────────────────────────────────────────────

function routeLine(r: ScannedRoute): string {
  const method = r.method.toUpperCase().padEnd(6)
  const path = r.path.padEnd(28)
  const loc = formatFilePath(r.file, r.line)
  return `  ${method} ${path} ${loc}`
}

function scanSummaryLine(result: ScanResult): string {
  const s = result.stats
  const parts = [`${s.protected} protected`]
  if (s.unprotectedMutations > 0) parts.push(`${s.unprotectedMutations} unprotected mutations`)
  if (s.unprotectedReads > 0) parts.push(`${s.unprotectedReads} unprotected reads`)
  if (s.uncertain > 0) parts.push(`${s.uncertain} to verify`)
  if (s.publicByConvention > 0) parts.push(`${s.publicByConvention} public by convention`)
  return `Summary: ${s.total} routes. ${parts.join(', ')}`
}

export function formatScan(result: ScanResult): string {
  const lines: string[] = []
  const bar = '─'.repeat(50)
  const s = result.stats

  lines.push(``)
  lines.push(`Prodgate Access Control Report`)
  lines.push(bar)
  lines.push(`Routes scanned: ${s.total}`)

  const mutations = result.routes.filter(r => r.state === 'unprotected' && r.isMutation && !r.likelyPublic)
  const reads = result.routes.filter(r => r.state === 'unprotected' && !r.isMutation && !r.likelyPublic)
  const uncertain = result.routes.filter(r => r.state === 'uncertain')
  const publicRoutes = result.routes.filter(r => r.state === 'unprotected' && r.likelyPublic)

  // Lead with the unambiguous, dangerous signal: unprotected mutations.
  if (mutations.length > 0) {
    lines.push(``)
    lines.push(`[CRITICAL] ${mutations.length} mutation route${mutations.length > 1 ? 's have' : ' has'} no auth`)
    lines.push(``)
    for (const r of mutations) lines.push(routeLine(r))
  }

  if (reads.length > 0) {
    lines.push(``)
    lines.push(`[WARNING] ${reads.length} read route${reads.length > 1 ? 's have' : ' has'} no auth`)
    lines.push(``)
    for (const r of reads) lines.push(routeLine(r))
  }

  if (uncertain.length > 0) {
    lines.push(``)
    lines.push(`[VERIFY] ${uncertain.length} route${uncertain.length > 1 ? 's use' : ' uses'} middleware Prodgate could not classify as auth`)
    lines.push(`(could be a custom guard; confirm these are intentional)`)
    lines.push(``)
    for (const r of uncertain) {
      lines.push(`${routeLine(r)}   (${r.unrecognized.join(', ')})`)
    }
  }

  if (publicRoutes.length > 0) {
    lines.push(``)
    lines.push(`[INFO] ${publicRoutes.length} route${publicRoutes.length > 1 ? 's look' : ' looks'} public by convention (login, health, webhooks)`)
    lines.push(``)
    for (const r of publicRoutes) lines.push(routeLine(r))
  }

  if (mutations.length === 0 && reads.length === 0 && uncertain.length === 0) {
    lines.push(``)
    const extra = publicRoutes.length > 0 ? ` (${publicRoutes.length} public by convention)` : ''
    lines.push(`No unprotected routes need review.${extra}`)
  }

  lines.push(``)
  lines.push(bar)
  lines.push(scanSummaryLine(result))
  lines.push(``)
  return lines.join('\n')
}

export function formatScanGithub(result: ScanResult): string {
  const lines: string[] = []
  const s = result.stats

  lines.push(`## Prodgate Access Control Scan`)
  lines.push(``)
  lines.push(`**${s.total} routes scanned.** ${scanSummaryLine(result).replace('Summary: ', '').replace(`${s.total} routes. `, '')}`)

  const mutations = result.routes.filter(r => r.state === 'unprotected' && r.isMutation && !r.likelyPublic)
  const reads = result.routes.filter(r => r.state === 'unprotected' && !r.isMutation && !r.likelyPublic)
  const uncertain = result.routes.filter(r => r.state === 'uncertain')

  if (mutations.length > 0) {
    lines.push(``)
    lines.push(`### Unprotected mutation routes (${mutations.length})`)
    for (const r of mutations) {
      lines.push(`- \`${r.method.toUpperCase()} ${r.path}\`: \`${formatFilePath(r.file, r.line)}\``)
    }
  }

  if (reads.length > 0) {
    lines.push(``)
    lines.push(`### Unprotected read routes (${reads.length})`)
    for (const r of reads) {
      lines.push(`- \`${r.method.toUpperCase()} ${r.path}\`: \`${formatFilePath(r.file, r.line)}\``)
    }
  }

  if (uncertain.length > 0) {
    lines.push(``)
    lines.push(`### To verify (${uncertain.length})`)
    lines.push(`Routes with middleware Prodgate could not classify as auth. Confirm these are intentional guards.`)
    for (const r of uncertain) {
      lines.push(`- \`${r.method.toUpperCase()} ${r.path}\`: \`${formatFilePath(r.file, r.line)}\` (\`${r.unrecognized.join(', ')}\`)`)
    }
  }

  if (mutations.length === 0 && reads.length === 0 && uncertain.length === 0) {
    lines.push(``)
    const extra = s.publicByConvention > 0 ? ` (${s.publicByConvention} public by convention)` : ''
    lines.push(`No unprotected routes need review.${extra}`)
  }

  return lines.join('\n')
}