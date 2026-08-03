/**
 * coverage.ts
 *
 * Generates the coverage manifest from the rule tables, so what Prodgate advertises
 * cannot drift from what it actually evaluates.
 */

import {
  STATEFUL_RESOURCES,
  DISRUPTIVE_REPLACE,
  DANGEROUS_MUTATIONS,
  POLICY_VERSION,
  POLICY_LAST_REVIEWED,
} from './resources'

export type CoverageEntry = {
  provider: string
  resourceType: string
  actions: string[]
  category: string
  ruleId: string
  defaultSeverity: string
  possibleSeverities: string[]
  severityCondition?: string
  evidenceFields: string[]
  rationale: string
  limitations: string[]
}

export type Coverage = {
  policyVersion: string
  lastReviewed: string
  entries: CoverageEntry[]
}

// A rule-level view for `explain`. Grouped rules cover many resource types, so the
// rule carries its own rationale rather than borrowing one entry's.
export type RuleSummary = {
  ruleId: string
  category: string
  defaultSeverity: string
  possibleSeverities: string[]
  severityCondition?: string
  actions: string[]
  evidenceFields: string[]
  rationale: string
  limitations: string[]
  entries: { resourceType: string; rationale: string }[]
}

// Rationales for the rules the classifier raises directly. They are not tied to a
// single resource type, so they are described once here.
const GENERIC_RULE_RATIONALES: Record<string, string> = {
  'PG-DESTROY-STATEFUL': 'Destroying or replacing a resource that holds data may cause data loss. Each covered resource type records what it holds.',
  'PG-DESTROY-STATEFUL-NONPROD': 'The same destruction as PG-DESTROY-STATEFUL, on a resource the team explicitly tagged as a non-production environment, so it is reported without blocking.',
  'PG-DESTROY-PROD': 'Destroying or replacing a resource that is classified as production, even when it holds no data, removes something production depends on.',
  'PG-DESTROY-OTHER': 'A resource is destroyed or replaced. It is neither data-holding nor production-classified, so it is reported for awareness.',
  'PG-DISRUPTION-NOTE': 'Replacing or removing a compute or network member interrupts service while it is recreated or gone. Reported as context, never as a finding.',
}

// Rules the classifier can emit that are not tied to the resource tables.
const CLASSIFIER_RULES: RuleSummary[] = [
  {
    ruleId: 'PG-DESTROY-STATEFUL-NONPROD',
    category: 'data_loss',
    defaultSeverity: 'WARNING',
    possibleSeverities: ['WARNING'],
    severityCondition: 'critical instead when the environment signals conflict or the resource is protected, reported as PG-DESTROY-STATEFUL',
    actions: ['delete', 'replace'],
    evidenceFields: ['change.actions', 'before.environmentClassification'],
    rationale: GENERIC_RULE_RATIONALES['PG-DESTROY-STATEFUL-NONPROD'],
    limitations: [
      'Relies on an explicit non-production environment tag. An untagged resource stays critical.',
      'Cannot determine whether usable backups or snapshots exist.',
    ],
    entries: [],
  },
  {
    ruleId: 'PG-DESTROY-PROD',
    category: 'availability',
    defaultSeverity: 'CRITICAL',
    possibleSeverities: ['CRITICAL'],
    actions: ['delete', 'replace'],
    evidenceFields: ['change.actions', 'before.environmentClassification'],
    rationale: GENERIC_RULE_RATIONALES['PG-DESTROY-PROD'],
    limitations: [
      'Production is inferred from environment tags, a production-looking Name tag, or the resource address.',
      'Cannot tell whether the resource is actually serving traffic.',
    ],
    entries: [],
  },
  {
    ruleId: 'PG-DESTROY-OTHER',
    category: 'availability',
    defaultSeverity: 'WARNING',
    possibleSeverities: ['WARNING'],
    actions: ['delete', 'replace'],
    evidenceFields: ['change.actions'],
    rationale: GENERIC_RULE_RATIONALES['PG-DESTROY-OTHER'],
    limitations: ['Cannot tell whether the resource is actually in use.'],
    entries: [],
  },
]

// Every rule id that can appear in a finding, described once.
export function buildRuleSummaries(): RuleSummary[] {
  const byId = new Map<string, RuleSummary>()
  for (const e of buildCoverage().entries) {
    const existing = byId.get(e.ruleId)
    if (existing) {
      existing.entries.push({ resourceType: e.resourceType, rationale: e.rationale })
      for (const a of e.actions) if (!existing.actions.includes(a)) existing.actions.push(a)
      continue
    }
    byId.set(e.ruleId, {
      ruleId: e.ruleId,
      category: e.category,
      defaultSeverity: e.defaultSeverity,
      possibleSeverities: e.possibleSeverities,
      severityCondition: e.severityCondition,
      actions: [...e.actions],
      evidenceFields: e.evidenceFields,
      rationale: GENERIC_RULE_RATIONALES[e.ruleId] ?? e.rationale,
      limitations: e.limitations,
      entries: [{ resourceType: e.resourceType, rationale: e.rationale }],
    })
  }
  for (const r of CLASSIFIER_RULES) if (!byId.has(r.ruleId)) byId.set(r.ruleId, r)
  return [...byId.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId))
}

// Limitations shared by every stateful destruction: the plan alone cannot show
// whether the data is recoverable.
const STATEFUL_LIMITATIONS = [
  'Cannot determine whether usable backups, snapshots, or versioning exist.',
  'Cannot verify recovery time or retention settings from this plan.',
]

export function buildCoverage(): Coverage {
  const entries: CoverageEntry[] = []

  for (const [type, info] of Object.entries(STATEFUL_RESOURCES)) {
    entries.push({
      provider: 'aws',
      resourceType: type,
      actions: ['delete', 'replace'],
      category: 'data_loss',
      ruleId: 'PG-DESTROY-STATEFUL',
      defaultSeverity: info.defaultSeverity,
      possibleSeverities: ['CRITICAL', 'WARNING'],
      severityCondition: 'warning only when a declared non-production environment and not protected',
      evidenceFields: ['change.actions'],
      rationale: `Destroying this resource may cause data loss: ${info.rationale}.`,
      limitations: STATEFUL_LIMITATIONS,
    })
  }

  for (const [type, info] of Object.entries(DISRUPTIVE_REPLACE)) {
    entries.push({
      provider: 'aws',
      resourceType: type,
      actions: ['delete', 'replace'],
      category: 'availability',
      ruleId: 'PG-DISRUPTION-NOTE',
      defaultSeverity: 'INFO',
      possibleSeverities: ['INFO'],
      evidenceFields: [],
      rationale: `Replacing or removing this ${info.category} member interrupts service while it is recreated or gone.`,
      limitations: ['Reported as an informational availability note, never a finding, and never affects the verdict.'],
    })
  }

  for (const rule of DANGEROUS_MUTATIONS) {
    const types = typeof rule.meta.resourceTypes === 'string' ? ['(all aws_ resource types)'] : rule.meta.resourceTypes
    for (const type of types) {
      entries.push({
        provider: 'aws',
        resourceType: type,
        actions: rule.meta.actions,
        category: rule.meta.category,
        ruleId: rule.id,
        defaultSeverity: rule.meta.defaultSeverity,
        possibleSeverities: rule.meta.possibleSeverities,
        severityCondition: rule.meta.severityCondition,
        evidenceFields: rule.meta.evidenceFields,
        rationale: rule.meta.rationale,
        limitations: rule.meta.limitations,
      })
    }
  }

  return { policyVersion: POLICY_VERSION, lastReviewed: POLICY_LAST_REVIEWED, entries }
}
