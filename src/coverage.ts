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
  severity: string
  evidenceFields: string[]
  limitation?: string
}

export type Coverage = {
  policyVersion: string
  lastReviewed: string
  entries: CoverageEntry[]
}

export function buildCoverage(): Coverage {
  const entries: CoverageEntry[] = []

  for (const [type, info] of Object.entries(STATEFUL_RESOURCES)) {
    entries.push({
      provider: 'aws',
      resourceType: type,
      actions: ['delete', 'replace'],
      category: 'data_loss',
      ruleId: 'PG-DESTROY-STATEFUL',
      severity: info.defaultSeverity,
      evidenceFields: ['change.actions'],
      limitation: info.rationale,
    })
  }

  for (const [type, info] of Object.entries(DISRUPTIVE_REPLACE)) {
    entries.push({
      provider: 'aws',
      resourceType: type,
      actions: ['delete', 'replace'],
      category: 'availability',
      ruleId: 'PG-DISRUPTION-NOTE',
      severity: 'INFO',
      evidenceFields: [],
      limitation: `${info.category}; reported as an informational availability note, never a finding`,
    })
  }

  for (const rule of DANGEROUS_MUTATIONS) {
    const types = rule.meta.resourceTypes === 'all' ? ['(all resource types)'] : rule.meta.resourceTypes
    for (const type of types) {
      entries.push({
        provider: 'aws',
        resourceType: type,
        actions: ['create', 'update', 'replace'],
        category: rule.meta.category,
        ruleId: rule.id,
        severity: rule.meta.severity,
        evidenceFields: rule.meta.evidenceFields,
        limitation: rule.meta.limitation,
      })
    }
  }

  return { policyVersion: POLICY_VERSION, lastReviewed: POLICY_LAST_REVIEWED, entries }
}
