/**
 * policy.ts
 *
 * The zero-config policy decisions, kept separate from the data tables in
 * resources.ts. Three questions: is a resource stateful (data loss on destroy),
 * does it look like production, and does an update match a dangerous-mutation rule.
 */

import { ResourceChange } from './plan'
import { STATEFUL_RESOURCES, DANGEROUS_MUTATIONS, MutationMatch } from './resources'

export function isStateful(rc: ResourceChange): boolean {
  return rc.type in STATEFUL_RESOURCES
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

export function isProduction(rc: ResourceChange): boolean {
  for (const [k, v] of Object.entries(rc.tags)) {
    if (PROD_TAG_KEYS.includes(k.toLowerCase()) && PROD_VALUE.test(v)) return true
  }
  return PROD_NAME.test(rc.address) && !NONPROD_NAME.test(rc.address)
}

export function matchDangerousMutations(rc: ResourceChange): MutationMatch[] {
  const out: MutationMatch[] = []
  for (const rule of DANGEROUS_MUTATIONS) {
    if (!rule.appliesTo(rc.type)) continue
    const m = rule.evaluate(rc.before, rc.after)
    if (m) out.push(m)
  }
  return out
}
