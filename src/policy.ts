/**
 * policy.ts
 *
 * The zero-config policy decisions, kept separate from the data tables in
 * resources.ts. Three questions: is a resource stateful (data loss on destroy),
 * does it look like production, and does an update match a dangerous-mutation rule.
 */

import { ResourceChange } from './plan'
import { STATEFUL_RESOURCES, DISRUPTIVE_REPLACE, DANGEROUS_MUTATIONS, MutationMatch } from './resources'

export function isStateful(rc: ResourceChange): boolean {
  return rc.type in STATEFUL_RESOURCES
}

export function statefulRationale(rc: ResourceChange): string {
  const specific = STATEFUL_RESOURCES[rc.type]?.rationale ?? 'this resource holds data'
  return `may cause data loss (${specific}); recovery depends on snapshots, backups, replication, retention, or versioning that Prodgate cannot verify from this plan`
}

export function isDisruptiveReplace(rc: ResourceChange): boolean {
  return rc.type in DISRUPTIVE_REPLACE
}

const PROD_TAG_KEYS = ['environment', 'env', 'stage', 'tier']
// A production tag value: "prod"/"production"/"prd"/"live", optionally followed
// by a separator-delimited suffix (e.g. "prod-us-east-1", "production_eu").
// Anchored at the start so "nonprod" / "prodigy" / "products" never match.
const PROD_VALUE = /^(prod|production|prd|live)([_.\-].*)?$/i
const PROD_NAME = /(^|[_\-./])prod(uction)?([_\-./0-9]|$)/i
// Veto: "non-prod" / "pre-prod" (and separator-free "nonprod"/"preprod") are
// non-production environments and must never be treated as prod.
const NONPROD_NAME = /(^|[_\-./])(non|pre)[_\-.]?prod/i

// Judges a specific side's tags plus the resource address. The address is the same
// for both sides of a replace, so it is passed in rather than read from one side.
export function isProductionTags(tags: Record<string, string>, address: string): boolean {
  for (const [k, v] of Object.entries(tags)) {
    if (PROD_TAG_KEYS.includes(k.toLowerCase()) && PROD_VALUE.test(v)) return true
  }
  return PROD_NAME.test(address) && !NONPROD_NAME.test(address)
}

// An explicit, team-declared non-production environment. This is the OPPOSITE and
// stronger question to isProduction: not "does this look non-prod?" but "did the
// team declare it non-prod?". Absence of a tag is not non-prod; unknown fails closed.
// Mirrors PROD_VALUE's tolerance for a separator-delimited suffix, so a
// region-scoped env tag like "dev-eu-west-1" or "staging_2" still downgrades.
const NONPROD_VALUE = /^(dev|develop|development|test|testing|qa|uat|preview|sandbox|sbx|ephemeral|staging|stage)([_.\-].*)?$/i

export function nonProductionTagFrom(tags: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(tags)) {
    if (PROD_TAG_KEYS.includes(k.toLowerCase()) && NONPROD_VALUE.test(v.trim())) return `${k}=${v}`
  }
  return null
}

export function matchDangerousMutations(rc: ResourceChange): MutationMatch[] {
  const out: MutationMatch[] = []
  for (const rule of DANGEROUS_MUTATIONS) {
    if (!rule.appliesTo(rc.type)) continue
    const m = rule.evaluate(rc.before, rc.after, rc.afterUnknown)
    if (m) out.push({ ...m, ruleId: rule.id })
  }
  return out
}
