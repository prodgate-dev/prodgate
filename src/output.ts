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

    case 'order_changed':
      return `${method} ${routePath} has auth middleware in a different position. Auth may run after the handler executes.`

    case 'new_unprotected_route':
      return `${method} ${routePath} was added with no access control middleware.`

    case 'router_auth_removed':
      return `All routes mounted under ${routePath} may now be accessible without authentication or authorization.`

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
      lines.push(`**\`${f.route.method.toUpperCase()} ${f.route.path}\`** — ${f.message}`)
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
      lines.push(`**\`${f.route.method.toUpperCase()} ${f.route.path}\`** — ${f.message}`)
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