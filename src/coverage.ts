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
    const types = rule.meta.resourceTypes === 'all' ? ['(all resource types)'] : rule.meta.resourceTypes
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
