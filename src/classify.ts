/**
 * classify.ts
 *
 * Turns parsed resource changes into a deterministic PlanResult with a pass/fail
 * verdict. The severity discipline is the heart of the low-noise promise:
 *
 *   delete/replace of a STATEFUL resource     -> CRITICAL (data loss, any environment)
 *   delete/replace of a PRODUCTION resource   -> CRITICAL
 *   delete/replace of anything else           -> WARNING (do not cry wolf on dev teardowns)
 *   an update matching a dangerous rule       -> CRITICAL or WARNING per the rule
 *   everything else                           -> no finding
 *
 * A human approval (the `prodgate-approved` label, surfaced as `approved`) keeps the
 * findings but flips the verdict to pass. `strict` also fails on warnings.
 */

import { ResourceChange } from './plan'
import { Severity } from './resources'
import { AgentInfo } from './agent'
import { isStateful, isProduction, matchDangerousMutations } from './policy'

export type FindingType =
  | 'destructive_stateful'
  | 'destructive_production'
  | 'destructive_other'
  | 'dangerous_mutation'

export type PlanFinding = {
  severity: Severity
  type: FindingType
  resource: { address: string; type: string }
  action: 'delete' | 'replace' | 'update'
  reason: string
  summary: string
  agentAuthored: boolean
  detail?: { attribute?: string }
}

export type Config = {
  ignore?: string[] // resource addresses (glob with *) to skip entirely
  allowDestroy?: string[] // addresses explicitly allowed to be destroyed
}

export type ClassifyOptions = {
  agent?: AgentInfo
  approved?: boolean
  strict?: boolean
  config?: Config
}

export type PlanResult = {
  findings: PlanFinding[]
  verdict: 'pass' | 'fail'
  approved: boolean
  strict: boolean
  agent: AgentInfo
  stats: {
    resourcesScanned: number
    destructive: number
    dangerous: number
    criticalCount: number
    warningCount: number
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function globMatch(value: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$')
    return re.test(value)
  }
  return value === pattern
}
function matchesAny(address: string, patterns?: string[]): boolean {
  return !!patterns && patterns.some(p => globMatch(address, p))
}

export function classifyPlan(changes: ResourceChange[], opts: ClassifyOptions = {}): PlanResult {
  const agent = opts.agent ?? { likelyAgent: false, signals: [] }
  const findings: PlanFinding[] = []

  for (const rc of changes) {
    if (matchesAny(rc.address, opts.config?.ignore)) continue

    if (rc.changeKind === 'delete' || rc.changeKind === 'replace') {
      if (matchesAny(rc.address, opts.config?.allowDestroy)) continue
      const action = rc.changeKind
      const verb = action === 'delete' ? 'deletes' : 'replaces'

      if (isStateful(rc)) {
        findings.push({
          severity: 'CRITICAL',
          type: 'destructive_stateful',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: `stateful resource; ${action} causes irreversible data loss`,
          summary: `${verb} a stateful resource (data loss)`,
          agentAuthored: agent.likelyAgent,
        })
      } else if (isProduction(rc)) {
        findings.push({
          severity: 'CRITICAL',
          type: 'destructive_production',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: 'production-tagged resource',
          summary: `${verb} a production resource`,
          agentAuthored: agent.likelyAgent,
        })
      } else {
        findings.push({
          severity: 'WARNING',
          type: 'destructive_other',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: 'resource is destroyed',
          summary: `${verb} a resource`,
          agentAuthored: agent.likelyAgent,
        })
      }
    } else if (rc.changeKind === 'update') {
      for (const m of matchDangerousMutations(rc)) {
        findings.push({
          severity: m.severity,
          type: 'dangerous_mutation',
          resource: { address: rc.address, type: rc.type },
          action: 'update',
          reason: m.summary,
          summary: m.summary,
          agentAuthored: agent.likelyAgent,
          detail: { attribute: m.attribute },
        })
      }
    }
  }

  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length
  const warningCount = findings.filter(f => f.severity === 'WARNING').length
  const destructive = findings.filter(f => f.type !== 'dangerous_mutation').length
  const dangerous = findings.filter(f => f.type === 'dangerous_mutation').length

  const approved = !!opts.approved
  const strict = !!opts.strict
  const blocking = criticalCount > 0 || (strict && warningCount > 0)
  const verdict: 'pass' | 'fail' = blocking && !approved ? 'fail' : 'pass'

  return {
    findings,
    verdict,
    approved,
    strict,
    agent,
    stats: { resourcesScanned: changes.length, destructive, dangerous, criticalCount, warningCount },
  }
}
