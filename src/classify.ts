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
 * A manual override (the `prodgate-approved` label in the Action, or --override on the
 * CLI) keeps the findings but flips an enforce-mode block to pass. `strict` is a
 * deprecated alias for fail-on warning.
 */

import { ResourceChange } from './plan'
import { Severity, RiskCategory, Confidence, Evidence } from './resources'
import { AgentInfo } from './agent'
import { isStateful, statefulRationale, isProductionTags, nonProductionTagFrom, isDisruptiveReplace, matchDangerousMutations } from './policy'

export type FindingType =
  | 'destructive_stateful'
  | 'destructive_stateful_nonprod'
  | 'destructive_production'
  | 'destructive_other'
  | 'dangerous_mutation'

export type PlanFinding = {
  ruleId: string
  severity: Severity
  category: RiskCategory
  confidence: Confidence
  type: FindingType
  resource: { address: string; type: string }
  action: 'delete' | 'replace' | 'update' | 'create'
  reason: string
  summary: string
  evidence: Evidence[]
  agentAuthored: boolean
  detail?: { attribute?: string }
}

export type Config = {
  schemaVersion?: number
  mode?: 'audit' | 'enforce'
  failOn?: 'critical' | 'warning' | 'never'
  ignore?: string[] // resource addresses (glob with *) to skip entirely
  allowDestruction?: string[] // addresses allowed to be destroyed; suppresses only the destruction finding
  allowDestroy?: string[] // deprecated alias for allowDestruction
}

export type EnforcementMode = 'audit' | 'enforce'
export type FailOn = 'critical' | 'warning' | 'never'
export type ExecutionOutcome = 'allowed' | 'blocked' | 'reported' | 'overridden'
// A recorded manual override. It is not a verified approval: it only states which
// label was present and which actor triggered the run, not that they reviewed the
// plan or are authorized.
export type OverrideInfo = {
  applied: boolean
  mechanism?: string
  label?: string
  workflowActor?: string
  headSha?: string
}

export type ClassifyOptions = {
  agent?: AgentInfo
  override?: OverrideInfo
  approved?: boolean // deprecated alias for override.applied
  strict?: boolean // deprecated alias for failOn: 'warning'
  mode?: EnforcementMode
  failOn?: FailOn
  config?: Config
  planHash?: string
  configPath?: string
  policyDigest?: string
}

export type PlanResult = {
  findings: PlanFinding[]
  // Resources whose replacement or removal affects availability. Informational only:
  // these never produce a finding and never affect the verdict.
  disruptions: { address: string; type: string; action: 'replace' | 'delete' }[]
  // Destructions that a configured allowDestruction exception suppressed. Recorded
  // so the report can show what was allowed and by which pattern.
  suppressions: { address: string; matchedBy?: string }[]
  // The policy decision from the findings and the failOn threshold, independent of
  // enforcement mode.
  policyVerdict: 'pass' | 'fail'
  enforcementMode: EnforcementMode
  failOn: FailOn
  // Whether this would block a merge in enforce mode, from the findings alone
  // (before any override).
  wouldBlock: boolean
  // The enforcement outcome that drives the exit code. It is 'fail' only when enforce
  // mode actually blocks; in audit mode it stays 'pass' even when wouldBlock is true.
  verdict: 'pass' | 'fail'
  // What actually happened, unambiguously, for integrations.
  executionOutcome: ExecutionOutcome
  // An override was requested (flag or label present). It only changes the outcome
  // when it was actually applied.
  overrideRequested: boolean
  // An override actually changed the outcome (only possible on an enforce-mode block).
  overrideApplied: boolean
  // Present only when overrideApplied is true.
  override?: OverrideInfo
  agent: AgentInfo
  planHash?: string
  configPath?: string
  policyDigest?: string
  stats: {
    resourcesScanned: number
    // Per-change-kind tallies for the plan digest. replaced is kept separate from
    // destroyed (Terraform folds a replace into add+destroy) so the digest and the
    // disruption note can reason about it.
    created: number
    updated: number
    replaced: number
    destroyed: number
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
function firstMatch(address: string, patterns?: string[]): string | undefined {
  return patterns?.find(p => globMatch(address, p))
}

export function classifyPlan(changes: ResourceChange[], opts: ClassifyOptions = {}): PlanResult {
  const agent = opts.agent ?? { likelyAgent: false, signals: [] }
  const findings: PlanFinding[] = []
  const disruptions: { address: string; type: string; action: 'replace' | 'delete' }[] = []
  const suppressions: { address: string; matchedBy?: string }[] = []
  let created = 0
  let updated = 0
  let replaced = 0
  let destroyed = 0

  for (const rc of changes) {
    if (matchesAny(rc.address, opts.config?.ignore)) continue

    if (rc.changeKind === 'create') created++
    else if (rc.changeKind === 'update') updated++
    else if (rc.changeKind === 'replace') replaced++
    else if (rc.changeKind === 'delete') destroyed++

    // Replacing or removing a compute or network member affects availability while it
    // is recreated or gone. Recorded for an informational note only, never a finding.
    if ((rc.changeKind === 'replace' || rc.changeKind === 'delete') && isDisruptiveReplace(rc)) {
      disruptions.push({ address: rc.address, type: rc.type, action: rc.changeKind })
    }

    const destructive = rc.changeKind === 'delete' || rc.changeKind === 'replace'

    // An allowDestruction exception suppresses only the destruction finding for this
    // resource. It must not skip analysis of the resulting state, so a replace that
    // is allowed to destroy is still checked for a dangerous recreate (for example a
    // database that comes back publicly accessible).
    const allowList = opts.config?.allowDestruction ?? opts.config?.allowDestroy
    const destroyAllowed = destructive && matchesAny(rc.address, allowList)
    if (destroyAllowed) {
      suppressions.push({ address: rc.address, matchedBy: firstMatch(rc.address, allowList) })
    }

    if (destructive && !destroyAllowed) {
      const action: 'delete' | 'replace' = rc.changeKind === 'delete' ? 'delete' : 'replace'
      const verb = action === 'delete' ? 'deletes' : 'replaces'
      const destroyEvidence: Evidence[] = [{ field: 'change.actions', observed: rc.actions.join('+') }]

      if (isStateful(rc)) {
        // Judge the destroyed object from its own (before) tags. Downgrade to WARNING
        // only on a team-declared non-production environment, and never when the
        // resource is protected or looks like prod. Unknown (untagged) or conflicting
        // signals fail closed at CRITICAL. Using beforeTags stops a replace that
        // re-tags the new object as dev from hiding the destruction of prod data.
        const npTag = nonProductionTagFrom(rc.beforeTags)
        const protectionOn = rc.before?.deletion_protection === true || rc.before?.deletion_protection_enabled === true
        const prodSignal = isProductionTags(rc.beforeTags, rc.address)
        if (npTag && !prodSignal && !protectionOn) {
          findings.push({
            ruleId: 'PG-DESTROY-STATEFUL-NONPROD',
            severity: 'WARNING',
            category: 'data_loss',
            confidence: 'medium',
            type: 'destructive_stateful_nonprod',
            resource: { address: rc.address, type: rc.type },
            action,
            reason: `stateful resource classified as a declared non-production environment; ${action} may cause data loss, and recovery depends on backups, snapshots, replication, retention, or versioning that Prodgate cannot verify from this plan`,
            summary: `${verb} a stateful resource in a declared non-production environment (data-loss risk)`,
            evidence: [...destroyEvidence, { field: 'before.environmentClassification', observed: 'non_production' }],
            agentAuthored: agent.likelyAgent,
          })
        } else if (npTag && (prodSignal || protectionOn)) {
          // The environment signals disagree: a non-production tag alongside a
          // production-looking address or deletion protection. Fail closed and say why.
          const conflict = prodSignal ? 'the address looks production' : 'deletion protection is enabled'
          findings.push({
            ruleId: 'PG-DESTROY-STATEFUL',
            severity: 'CRITICAL',
            category: 'data_loss',
            confidence: 'high',
            type: 'destructive_stateful',
            resource: { address: rc.address, type: rc.type },
            action,
            reason: `conflicting production and non-production environment signals (${conflict}); failing closed because this destructive change may affect production data`,
            summary: `${verb} a stateful resource (conflicting signals, data-loss risk)`,
            evidence: [
              ...destroyEvidence,
              { field: 'before.environmentClassification', observed: 'conflicting' },
              ...(protectionOn ? [{ field: 'before.deletionProtection', observed: 'enabled' }] : []),
            ],
            agentAuthored: agent.likelyAgent,
          })
        } else {
          findings.push({
            ruleId: 'PG-DESTROY-STATEFUL',
            severity: 'CRITICAL',
            category: 'data_loss',
            confidence: 'high',
            type: 'destructive_stateful',
            resource: { address: rc.address, type: rc.type },
            action,
            reason: statefulRationale(rc),
            summary: `${verb} a stateful resource (data-loss risk)`,
            evidence: destroyEvidence,
            agentAuthored: agent.likelyAgent,
          })
        }
      } else if (isProductionTags(rc.beforeTags, rc.address)) {
        findings.push({
          ruleId: 'PG-DESTROY-PROD',
          severity: 'CRITICAL',
          category: 'availability',
          confidence: 'medium',
          type: 'destructive_production',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: 'production-tagged resource',
          summary: `${verb} a production resource`,
          evidence: [...destroyEvidence, { field: 'before.environmentClassification', observed: 'production' }],
          agentAuthored: agent.likelyAgent,
        })
      } else {
        findings.push({
          ruleId: 'PG-DESTROY-OTHER',
          severity: 'WARNING',
          category: 'availability',
          confidence: 'low',
          type: 'destructive_other',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: 'resource is destroyed',
          summary: `${verb} a resource`,
          evidence: destroyEvidence,
          agentAuthored: agent.likelyAgent,
        })
      }
    }

    // Dangerous mutations are evaluated on the resulting state, so they apply to
    // creates and replaces (a brand-new public database or world-open rule is as
    // dangerous as one mutated into that state), not only in-place updates.
    if (rc.changeKind === 'create' || rc.changeKind === 'update' || rc.changeKind === 'replace') {
      const action: 'create' | 'update' | 'replace' = rc.changeKind
      for (const m of matchDangerousMutations(rc)) {
        findings.push({
          ruleId: m.ruleId,
          severity: m.severity,
          category: m.category,
          confidence: m.confidence,
          type: 'dangerous_mutation',
          resource: { address: rc.address, type: rc.type },
          action,
          reason: m.summary,
          summary: m.summary,
          evidence: m.evidence,
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

  const overrideRequest: OverrideInfo | undefined = opts.override ?? (opts.approved ? { applied: true, mechanism: 'manual' } : undefined)
  const overrideRequested = !!overrideRequest?.applied
  const failOn: FailOn = opts.failOn ?? (opts.strict ? 'warning' : 'critical')
  const mode: EnforcementMode = opts.mode ?? 'enforce'
  const policyBlocking =
    failOn === 'never' ? false
    : failOn === 'warning' ? criticalCount > 0 || warningCount > 0
    : criticalCount > 0
  const policyVerdict: 'pass' | 'fail' = policyBlocking ? 'fail' : 'pass'
  // wouldBlock is the pre-override enforcement result: would this block in enforce
  // mode on the findings alone. An override only actually applies to an enforce-mode
  // block; in audit mode nothing needs overriding, and a passing plan has nothing to
  // override.
  const wouldBlock = policyBlocking
  const overrideApplied = mode === 'enforce' && policyBlocking && overrideRequested
  const override: OverrideInfo | undefined = overrideApplied ? { ...overrideRequest, applied: true } : undefined
  const verdict: 'pass' | 'fail' = mode === 'enforce' && policyBlocking && !overrideApplied ? 'fail' : 'pass'
  const executionOutcome: ExecutionOutcome =
    !policyBlocking ? 'allowed'
    : mode === 'audit' ? 'reported'
    : overrideApplied ? 'overridden'
    : 'blocked'

  return {
    findings,
    disruptions,
    suppressions,
    policyVerdict,
    enforcementMode: mode,
    failOn,
    wouldBlock,
    verdict,
    executionOutcome,
    overrideRequested,
    overrideApplied,
    override,
    agent,
    planHash: opts.planHash,
    configPath: opts.configPath,
    policyDigest: opts.policyDigest,
    stats: { resourcesScanned: changes.length, created, updated, replaced, destroyed, destructive, dangerous, criticalCount, warningCount },
  }
}
