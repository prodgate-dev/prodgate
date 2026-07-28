/**
 * case_plan.ts
 *
 * The validation gate. Loads synthetic terraform plan fixtures and asserts the
 * classifier's verdict, finding types, agent flag, and approval behaviour. Bar:
 * zero false-blocks on safe plans, catches every destructive/dangerous plan,
 * works zero-config.
 */

import * as fs from 'fs'
import * as path from 'path'
import { parsePlan } from '../src/plan'
import { classifyPlan } from '../src/classify'
import { detectAgent } from '../src/agent'

const fixture = (name: string) =>
  parsePlan(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))

let failures = 0
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!cond) failures++
}
function throwsCode(label: string, fn: () => unknown, code: string) {
  try {
    fn()
    check(label + ' (did not throw)', false)
  } catch (e: any) {
    check(label, !!e && e.code === code)
  }
}
// Build a one-resource managed plan for focused rule tests.
function plan1(type: string, name: string, change: any) {
  return parsePlan(JSON.stringify({ format_version: '1.2', resource_changes: [{ address: `${type}.${name}`, type, name, mode: 'managed', change }] }))
}
function hasUnknownWarning(r: { findings: { severity: string; summary: string }[] }): boolean {
  return r.findings.some(f => f.severity === 'WARNING' && /unknown/i.test(f.summary))
}

console.log('\nProdgate plan classification')
console.log('─'.repeat(50))

// Destructive stateful -> CRITICAL, fail
{
  const r = classifyPlan(fixture('delete-db.json'))
  check('delete-db: fail, 1 critical stateful', r.verdict === 'fail' && r.stats.criticalCount === 1 && r.findings[0].type === 'destructive_stateful')
}

// Replace of a stateful resource -> CRITICAL, fail
{
  const r = classifyPlan(fixture('replace-volume.json'))
  check('replace-volume: fail, stateful replace', r.verdict === 'fail' && r.findings.some(f => f.type === 'destructive_stateful' && f.action === 'replace'))
}

// Benign update -> pass, no findings
{
  const r = classifyPlan(fixture('safe-update.json'))
  check('safe-update: pass, 0 findings', r.verdict === 'pass' && r.findings.length === 0)
}

// Creates only -> pass
{
  const r = classifyPlan(fixture('create-only.json'))
  check('create-only: pass, 0 findings', r.verdict === 'pass' && r.findings.length === 0)
}

// Non-stateful non-prod destroy -> WARNING, pass (unless --strict)
{
  const r = classifyPlan(fixture('delete-dev-lambda.json'))
  check('delete-dev-lambda: pass, 1 warning (no cry-wolf)', r.verdict === 'pass' && r.stats.warningCount === 1 && r.findings[0].type === 'destructive_other')
  const rs = classifyPlan(fixture('delete-dev-lambda.json'), { strict: true })
  check('delete-dev-lambda --strict: fail', rs.verdict === 'fail')
}

// Dangerous mutation: DB made public -> CRITICAL, fail
{
  const r = classifyPlan(fixture('public-db.json'))
  check('public-db: fail, dangerous_mutation', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL'))
}

// Dangerous mutation: sensitive port opened to the world -> CRITICAL, fail
{
  const r = classifyPlan(fixture('sg-open-world.json'))
  check('sg-open-world: fail, critical mutation', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL'))
}

// Dangerous mutation: deletion protection disabled -> CRITICAL, fail
{
  const r = classifyPlan(fixture('disable-deletion-protection.json'))
  check('disable-deletion-protection: fail', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation'))
}

// Agent detection + finding flag
{
  const agent = detectAgent({ commitMessages: 'refactor db setup\n\nCo-Authored-By: Claude <noreply@anthropic.com>' })
  check('agent: detected from co-author trailer', agent.likelyAgent && agent.signals.length > 0)
  const r = classifyPlan(fixture('delete-db.json'), { agent })
  check('agent: finding flagged agentAuthored', r.findings[0].agentAuthored === true)
}

// Non-agent commit is not flagged
{
  const agent = detectAgent({ commitMessages: 'fix typo in module', author: 'jane' })
  check('agent: ordinary commit not flagged', agent.likelyAgent === false)
}

// Approval keeps the finding but flips the verdict to pass
{
  const r = classifyPlan(fixture('delete-db.json'), { approved: true })
  check('override alias (approved): pass, finding still reported, outcome overridden', r.verdict === 'pass' && r.overrideApplied && r.executionOutcome === 'overridden' && r.findings.length === 1)
}

// ── real-plan shapes (hardening) ──────────────────────────────────────────

// Module-nested address still resolves type/statefulness -> CRITICAL
{
  const r = classifyPlan(fixture('module-nested-delete.json'))
  check('module-nested-delete: fail, stateful in a module', r.verdict === 'fail' && r.findings[0].type === 'destructive_stateful' && r.findings[0].resource.address.startsWith('module.'))
}

// for_each-indexed address + prod-region tag in tags_all -> CRITICAL
{
  const r = classifyPlan(fixture('foreach-replica-delete.json'))
  check('foreach-replica-delete: fail, indexed stateful', r.verdict === 'fail' && r.stats.criticalCount === 1)
}

// non-prod / pre-prod teardown must NOT cry wolf -> WARNING, pass
{
  const r = classifyPlan(fixture('nonprod-teardown.json'))
  check('nonprod-teardown: pass, no false prod block', r.verdict === 'pass' && r.stats.criticalCount === 0 && r.findings.every(f => f.type === 'destructive_other'))
}

// Region-suffixed prod tag on a non-stateful resource -> CRITICAL production
{
  const r = classifyPlan(fixture('prod-region-tag-delete.json'))
  check('prod-region-tag-delete: fail, production recognized', r.verdict === 'fail' && r.findings[0].type === 'destructive_production')
}

// Computed/unknown after values must not crash or false-flag -> pass
{
  const r = classifyPlan(fixture('computed-unknown-update.json'))
  check('computed-unknown-update: pass, unknown ingress flagged for review', r.verdict === 'pass' && r.stats.criticalCount === 0 && r.findings.length === 1 && /unknown/i.test(r.findings[0].summary))
}

// Large mixed plan: data source skipped, no-ops ignored, prod replace caught,
// dev teardown stays a warning
{
  const r = classifyPlan(fixture('large-mixed-plan.json'))
  check('large-mixed-plan: 1 critical (prod cache replace), 1 warning (dev lambda)', r.verdict === 'fail' && r.stats.criticalCount === 1 && r.stats.warningCount === 1 && r.findings.some(f => f.type === 'destructive_stateful' && f.action === 'replace'))
}

// ── dangerous creates, not only updates ───────────────────────────────────

// Creating a publicly accessible database -> CRITICAL
{
  const r = classifyPlan(fixture('create-public-db.json'))
  check('create-public-db: fail, dangerous create', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation' && f.action === 'create' && f.severity === 'CRITICAL'))
}

// Creating an SSH rule open to the world -> CRITICAL (sensitive port)
{
  const r = classifyPlan(fixture('create-ssh-open-world.json'))
  check('create-ssh-open-world: fail, critical create', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL'))
}

// Creating a wildcard IAM policy -> WARNING (passes without --strict)
{
  const r = classifyPlan(fixture('create-wildcard-iam.json'))
  check('create-wildcard-iam: warning, not critical', r.verdict === 'pass' && r.stats.warningCount === 1 && r.findings[0].type === 'dangerous_mutation')
}

// Creating a public web SG on 80/443 must NOT cry wolf -> WARNING, pass
{
  const r = classifyPlan(fixture('create-public-web-sg.json'))
  check('create-public-web-sg: warning only, no false critical', r.verdict === 'pass' && r.stats.criticalCount === 0 && r.stats.warningCount === 1)
}

// ── security-group correctness (review Tier 1/2) ───────────────────────────

// A standard allow-all egress rule must NOT be flagged as an opening
{
  const r = classifyPlan(fixture('egress-allow-world.json'))
  check('egress-allow-world: pass, egress is not an opening', r.verdict === 'pass' && r.findings.length === 0)
}

// protocol "-1" means all ports: all traffic from the world -> CRITICAL
{
  const r = classifyPlan(fixture('sg-all-traffic-world.json'))
  check('sg-all-traffic-world: fail, all-ports critical', r.verdict === 'fail' && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL'))
}

// SSH open to ::/0 (IPv6) -> CRITICAL
{
  const r = classifyPlan(fixture('sg-ipv6-ssh-world.json'))
  check('sg-ipv6-ssh-world: fail, ipv6 world-open detected', r.verdict === 'fail' && r.findings.some(f => f.severity === 'CRITICAL'))
  const f = r.findings.find(x => x.type === 'dangerous_mutation')
  check('sg-ipv6: finding names ::/0, not 0.0.0.0/0', !!f && /::\/0/.test(f.summary) && f.evidence.some(e => /::\/0/.test(e.observed)) && !/0\.0\.0\.0\/0/.test(f.summary))
}

// aws_vpc_security_group_ingress_rule uses ip_protocol; "-1" is all ports -> CRITICAL
{
  const r = classifyPlan(fixture('sg-ip-protocol-all.json'))
  check('sg-ip-protocol-all: fail, ip_protocol all-ports critical', r.verdict === 'fail' && r.findings.some(f => f.severity === 'CRITICAL'))
}

// ── ephemeral-environment severity ladder (review Tier 3.2) ────────────────

// Declared-dev stateful teardown -> WARNING, pass (fails under --strict)
{
  const r = classifyPlan(fixture('delete-dev-db.json'))
  check('delete-dev-db: warning, declared non-prod', r.verdict === 'pass' && r.stats.warningCount === 1 && r.findings[0].type === 'destructive_stateful_nonprod')
  const rs = classifyPlan(fixture('delete-dev-db.json'), { strict: true })
  check('delete-dev-db --strict: fail', rs.verdict === 'fail')
}

// staging counts as declared non-prod -> WARNING
{
  const r = classifyPlan(fixture('delete-staging-db.json'))
  check('delete-staging-db: warning, staging is non-prod', r.verdict === 'pass' && r.findings[0].type === 'destructive_stateful_nonprod')
}

// region-suffixed non-prod tag (dev-eu-west-1) still downgrades -> WARNING
{
  const r = classifyPlan(fixture('delete-dev-region-db.json'))
  check('delete-dev-region-db: warning, suffixed non-prod tag', r.verdict === 'pass' && r.findings[0].type === 'destructive_stateful_nonprod')
}

// deletion_protection overrides the downgrade -> CRITICAL
{
  const r = classifyPlan(fixture('delete-dev-db-protected.json'))
  check('delete-dev-db-protected: fail, protection overrides', r.verdict === 'fail' && r.findings[0].type === 'destructive_stateful')
}

// Conflicting signals (prod-looking name + dev tag) fail closed -> CRITICAL
{
  const r = classifyPlan(fixture('delete-conflict-db.json'))
  check('delete-conflict-db: fail, conflict fails closed with explanation', r.verdict === 'fail' && r.findings[0].type === 'destructive_stateful' && /conflicting/i.test(r.findings[0].reason))
}

// Untagged stateful delete stays CRITICAL (unknown fails closed)
{
  const r = classifyPlan(fixture('delete-db.json'))
  check('delete-db (untagged): still critical', r.findings[0].type === 'destructive_stateful')
}

// ── agent detection precision (review Tier 2.3) ────────────────────────────

{
  check('agent: human "devinsmith" not flagged', detectAgent({ author: 'devinsmith' }).likelyAgent === false)
  check('agent: prose "moved the cursor" not flagged', detectAgent({ commitMessages: 'moved the cursor to end of line' }).likelyAgent === false)
  check('agent: bare agent word in PR body not flagged', detectAgent({ prBody: 'we should use codex here maybe' }).likelyAgent === false)
  check('agent: "cursor[bot]" author flagged', detectAgent({ author: 'cursor[bot]' }).likelyAgent === true)
  check('agent: PR-body generated marker flagged', detectAgent({ prBody: '🤖 Generated with Claude Code' }).likelyAgent === true)
  check('agent: renovate[bot] not an AI agent', detectAgent({ author: 'renovate[bot]' }).likelyAgent === false)
  check('agent: dependabot[bot] not an AI agent', detectAgent({ author: 'dependabot[bot]' }).likelyAgent === false)
}

// ── finding model (rule ids, category, confidence, evidence) ────────────────

{
  const f = classifyPlan(fixture('delete-db.json')).findings[0]
  check('stateful finding carries id/category/confidence/evidence', f.ruleId === 'PG-DESTROY-STATEFUL' && f.category === 'data_loss' && f.confidence === 'high' && f.evidence.some(e => e.field === 'change.actions'))
}
{
  const f = classifyPlan(fixture('public-db.json')).findings.find(x => x.type === 'dangerous_mutation')
  check('mutation finding carries rule id and exposure category', !!f && f.ruleId === 'PG-AWS-RDS-PUBLIC' && f.category === 'exposure' && f.evidence.length > 0)
}
{
  const r = classifyPlan(fixture('large-mixed-plan.json'))
  const ok = r.findings.length > 0 && r.findings.every(f => typeof f.ruleId === 'string' && f.ruleId.length > 0 && typeof f.category === 'string' && typeof f.confidence === 'string' && Array.isArray(f.evidence))
  check('every finding has id/category/confidence/evidence', ok)
}

// ── enforcement mode and failOn ────────────────────────────────────────────

{
  const r = classifyPlan(fixture('delete-db.json'), { mode: 'enforce', failOn: 'critical' })
  check('enforce + critical: blocks', r.verdict === 'fail' && r.policyVerdict === 'fail' && r.wouldBlock === true && r.enforcementMode === 'enforce')
}
{
  const r = classifyPlan(fixture('delete-db.json'), { mode: 'audit', failOn: 'critical' })
  check('audit + critical: does not block but wouldBlock', r.verdict === 'pass' && r.policyVerdict === 'fail' && r.wouldBlock === true && r.enforcementMode === 'audit')
}
{
  const r = classifyPlan(fixture('delete-db.json'), { failOn: 'never' })
  check('failOn never: a critical does not fail the policy', r.policyVerdict === 'pass' && r.verdict === 'pass')
}

// executionOutcome distinguishes the four outcomes, and an override only applies to
// an enforce-mode block.
const OV = { applied: true, mechanism: 'github_label' as const, label: 'prodgate-approved', workflowActor: 'octocat', headSha: 'abc' }
{
  check('outcome allowed on a clean plan', classifyPlan(fixture('create-only.json')).executionOutcome === 'allowed')
  check('outcome blocked in enforce, no override', classifyPlan(fixture('delete-db.json')).executionOutcome === 'blocked')
  check('outcome reported in audit', classifyPlan(fixture('delete-db.json'), { mode: 'audit' }).executionOutcome === 'reported')

  // A clean plan with an override request applies nothing.
  const clean = classifyPlan(fixture('create-only.json'), { override: OV })
  check('clean plan + override request: allowed, not applied', clean.executionOutcome === 'allowed' && clean.overrideApplied === false && clean.override === undefined && clean.overrideRequested === true)

  // Audit already does not block, so an override request stays reported.
  const audit = classifyPlan(fixture('delete-db.json'), { mode: 'audit', override: OV })
  check('audit + override request: still reported, not applied', audit.executionOutcome === 'reported' && audit.overrideApplied === false)

  // Enforce block with an override request is the only case where it applies.
  const ov = classifyPlan(fixture('delete-db.json'), { override: OV })
  check('enforce block + override request: overridden with metadata', ov.executionOutcome === 'overridden' && ov.overrideApplied === true && ov.wouldBlock === true && ov.override?.workflowActor === 'octocat' && ov.override?.headSha === 'abc')
}
{
  const r = classifyPlan(fixture('delete-dev-lambda.json'), { failOn: 'warning' })
  check('failOn warning: a warning-only plan fails', r.policyVerdict === 'fail' && r.verdict === 'fail')
}

// ── unknown / computed values ──────────────────────────────────────────────

// A database whose resulting publicly_accessible is unknown at plan time cannot be
// confirmed safe, so it is flagged for review as a WARNING, never asserted safe.
{
  const r = classifyPlan(fixture('db-public-unknown.json'))
  check('db-public-unknown: warning needs-review, not critical', r.verdict === 'pass' && r.stats.criticalCount === 0 && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'WARNING' && /unknown/i.test(f.summary)))
}

// Every security-critical rule flags an unknown resulting value for review, and does
// not flag a nearby case where the value is known and safe.

// deletion protection
{
  const r = classifyPlan(plan1('aws_db_instance', 'db', { actions: ['update'], before: { deletion_protection: true }, after: { deletion_protection: null }, after_unknown: { deletion_protection: true } }))
  check('deletion-protection unknown: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const r = classifyPlan(plan1('aws_db_instance', 'db', { actions: ['update'], before: { deletion_protection: true }, after: { deletion_protection: true } }))
  check('deletion-protection unchanged and known: no finding', r.findings.length === 0)
}

// S3 public access block
{
  const on = { block_public_acls: true, ignore_public_acls: true, block_public_policy: true, restrict_public_buckets: true }
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['update'], before: on, after: { ...on, block_public_acls: null }, after_unknown: { block_public_acls: true } }))
  check('s3 pab unknown: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const on = { block_public_acls: true, ignore_public_acls: true, block_public_policy: true, restrict_public_buckets: true }
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['update'], before: on, after: on }))
  check('s3 pab unchanged and known: no finding', r.findings.length === 0)
}

// S3 public access block on create: an unknown protection means the all-disabled
// state cannot be ruled out.
{
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['create'], before: null, after: { block_public_acls: null, ignore_public_acls: false, block_public_policy: false, restrict_public_buckets: false }, after_unknown: { block_public_acls: true } }))
  check('s3 create three-false one-unknown: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['create'], before: null, after: { block_public_acls: null, ignore_public_acls: null, block_public_policy: null, restrict_public_buckets: null }, after_unknown: { block_public_acls: true, ignore_public_acls: true, block_public_policy: true, restrict_public_buckets: true } }))
  check('s3 create all-unknown: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['create'], before: null, after: { block_public_acls: true, ignore_public_acls: null, block_public_policy: null, restrict_public_buckets: null }, after_unknown: { ignore_public_acls: true, block_public_policy: true, restrict_public_buckets: true } }))
  check('s3 create one-known-true rest-unknown: no finding', r.findings.length === 0)
}
{
  const r = classifyPlan(plan1('aws_s3_bucket_public_access_block', 'b', { actions: ['create'], before: null, after: { block_public_acls: false, ignore_public_acls: false, block_public_policy: false, restrict_public_buckets: false } }))
  check('s3 create all-false: critical', r.findings.some(f => f.severity === 'CRITICAL'))
}

// security group ingress
{
  const r = classifyPlan(plan1('aws_security_group', 'sg', { actions: ['update'], before: { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }] }, after: { ingress: null }, after_unknown: { ingress: true } }))
  check('sg ingress unknown: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const r = classifyPlan(plan1('aws_security_group', 'sg', { actions: ['update'], before: { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }] }, after: { ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }] } }))
  check('sg ingress unchanged internal: no finding', r.findings.length === 0)
}

// IAM policy
{
  const nonWildcard = '{"Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::b/*"}]}'
  const r = classifyPlan(plan1('aws_iam_policy', 'p', { actions: ['update'], before: { policy: nonWildcard }, after: { policy: null }, after_unknown: { policy: true } }))
  check('iam policy unknown: needs review', hasUnknownWarning(r))
}
{
  const r = classifyPlan(plan1('aws_iam_policy', 'p', { actions: ['update'], before: { policy: '{"Statement":[{"Effect":"Allow","Action":"s3:GetObject"}]}' }, after: { policy: '{"Statement":[{"Effect":"Allow","Action":"s3:PutObject"}]}' } }))
  check('iam policy known non-wildcard: no finding', r.findings.length === 0)
}

// Nested and list-shaped unknowns inside the relevant subtree are detected.
{
  const internal = { from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }
  const r = classifyPlan(plan1('aws_security_group', 'sg', { actions: ['update'], before: { ingress: [internal] }, after: { ingress: [{ ...internal, cidr_blocks: null }] }, after_unknown: { ingress: [{ cidr_blocks: [true] }] } }))
  check('sg nested unknown cidr in ingress: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}
{
  const r = classifyPlan(plan1('aws_security_group_rule', 'r', { actions: ['update'], before: { type: 'ingress', cidr_blocks: ['10.0.0.0/8'] }, after: { type: 'ingress', cidr_blocks: ['10.0.0.0/8', null] }, after_unknown: { cidr_blocks: [false, true] } }))
  check('sg rule partially unknown cidr list: needs review', hasUnknownWarning(r) && r.stats.criticalCount === 0)
}

// Unknowns unrelated to a security rule must not warn.
{
  const r = classifyPlan(plan1('aws_db_instance', 'db', { actions: ['update'], before: { publicly_accessible: false }, after: { publicly_accessible: false, arn: null }, after_unknown: { arn: true } }))
  check('unrelated unknown (arn): no finding', r.findings.length === 0)
}
{
  const internal = { from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'], description: 'web' }
  const r = classifyPlan(plan1('aws_security_group', 'sg', { actions: ['update'], before: { ingress: [internal] }, after: { ingress: [{ ...internal, description: null }] }, after_unknown: { ingress: [{ description: [true] }] } }))
  check('sg unknown non-cidr field in ingress: no finding', r.findings.length === 0)
}

// ── plan input validation (fail closed) ────────────────────────────────────

throwsCode('empty object rejected', () => parsePlan('{}'), 'UNRECOGNIZED_DOCUMENT')
throwsCode('top-level array rejected', () => parsePlan('[]'), 'UNRECOGNIZED_DOCUMENT')
throwsCode('state file rejected', () => parsePlan('{"format_version":"1.0","values":{"root_module":{}}}'), 'UNRECOGNIZED_DOCUMENT')
throwsCode('truncated json rejected', () => parsePlan('{"resource_changes":['), 'INVALID_JSON')
throwsCode('resource_changes wrong type rejected', () => parsePlan('{"resource_changes":"wrong"}'), 'INVALID_RESOURCE_CHANGE')
throwsCode('missing actions rejected', () => parsePlan('{"resource_changes":[{"address":"a.b","type":"a","name":"b","change":{}}]}'), 'INVALID_RESOURCE_CHANGE')
throwsCode('unknown action rejected', () => parsePlan('{"resource_changes":[{"address":"a.b","type":"a","name":"b","change":{"actions":["frobnicate"]}}]}'), 'UNSUPPORTED_ACTION')
throwsCode('unsupported format_version rejected', () => parsePlan('{"format_version":"99.0","resource_changes":[]}'), 'UNSUPPORTED_FORMAT')
throwsCode('malformed data source rejected', () => parsePlan('{"format_version":"1.2","resource_changes":[{"mode":"data","address":"data.x.y"}]}'), 'INVALID_RESOURCE_CHANGE')
throwsCode('missing identity rejected', () => parsePlan('{"format_version":"1.2","resource_changes":[{"change":{"actions":["delete"]}}]}'), 'INVALID_RESOURCE_CHANGE')
throwsCode('impossible action combo rejected', () => parsePlan('{"format_version":"1.2","resource_changes":[{"address":"a.b","type":"a","name":"b","change":{"actions":["create","update"]}}]}'), 'UNSUPPORTED_ACTION')

// A valid plan with an empty resource_changes array is a real no-change plan.
{
  const r = classifyPlan(parsePlan('{"format_version":"1.2","resource_changes":[]}'))
  check('valid no-change plan: pass, 0 scanned', r.verdict === 'pass' && r.stats.resourcesScanned === 0)
}

// A plan containing only a valid data-source read is a valid no-managed-change plan.
{
  const r = classifyPlan(parsePlan('{"format_version":"1.2","resource_changes":[{"mode":"data","address":"data.aws_ami.x","type":"aws_ami","name":"x","change":{"actions":["read"],"before":null,"after":null}}]}'))
  check('data-only plan: pass, 0 scanned', r.verdict === 'pass' && r.stats.resourcesScanned === 0)
}

// ── allowDestruction scoping ───────────────────────────────────────────────

// An allowed destroy suppresses the destruction finding and records the exception.
{
  const r = classifyPlan(fixture('delete-db.json'), { config: { allowDestruction: ['aws_db_instance.main'] } })
  check('allowDestruction: destroy suppressed, no finding', r.verdict === 'pass' && r.findings.length === 0 && r.suppressions.length === 1 && r.suppressions[0].matchedBy === 'aws_db_instance.main')
}

// Without an exception, a public database replacement produces both findings: the
// destruction of the existing data and the dangerous public recreate.
{
  const r = classifyPlan(fixture('allow-destroy-public-replace.json'))
  check('public db replacement: both destruction and exposure are critical', r.verdict === 'fail' && r.findings.some(f => f.type === 'destructive_stateful' && f.severity === 'CRITICAL') && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL'))
}

// An allowed replace that comes back publicly accessible still fails on exposure:
// the exception permits the destroy, not a dangerous recreate.
{
  const r = classifyPlan(fixture('allow-destroy-public-replace.json'), { config: { allowDestruction: ['aws_db_instance.scratch'] } })
  check('allowDestruction: destruction allowed but exposure still critical', r.verdict === 'fail' && r.suppressions.length === 1 && r.findings.some(f => f.type === 'dangerous_mutation' && f.severity === 'CRITICAL') && r.findings.every(f => f.type !== 'destructive_stateful'))
}

// The deprecated allowDestroy alias still works.
{
  const r = classifyPlan(fixture('delete-db.json'), { config: { allowDestroy: ['aws_db_instance.main'] } })
  check('allowDestroy alias: still suppresses destruction', r.verdict === 'pass' && r.suppressions.length === 1)
}

// ── resource semantics ─────────────────────────────────────────────────────

// An Aurora cluster instance is compute, not storage. Deleting one is an
// availability concern, not irreversible data loss, so it must not be flagged as
// a stateful data-loss critical.
{
  const r = classifyPlan(fixture('aurora-instance-delete.json'))
  check('aurora-instance-delete: not stateful data loss', r.stats.criticalCount === 0 && r.findings.every(f => f.type !== 'destructive_stateful'))
}

// A global cluster owns replication topology, not the member storage. Deleting it is
// an availability concern, not stateful data loss.
{
  const r = classifyPlan(fixture('delete-global-cluster.json'))
  check('delete-global-cluster: availability, not data loss', r.findings.every(f => f.type !== 'destructive_stateful') && r.disruptions.some(d => d.type === 'aws_rds_global_cluster'))
}

// ── before/after tag semantics ─────────────────────────────────────────────

// A production database replaced by a dev-tagged object still destroys prod data.
// The destroyed side is judged from before tags, so the re-tag cannot downgrade it.
{
  const r = classifyPlan(fixture('replace-retag-prod-to-dev.json'))
  check('replace-retag-prod-to-dev: fail, destruction judged from before', r.verdict === 'fail' && r.stats.criticalCount === 1 && r.findings[0].type === 'destructive_stateful' && r.findings[0].action === 'replace')
}

// dev -> prod replace: the destroyed object is dev, so a warning, and the new
// production object is evaluated separately (nothing dangerous here).
{
  const r = classifyPlan(fixture('replace-retag-dev-to-prod.json'))
  check('replace-retag-dev-to-prod: warning from before-dev, not critical', r.stats.criticalCount === 0 && r.findings.some(f => f.type === 'destructive_stateful_nonprod'))
}

// A delete is classified from before tags: a prod-tagged non-stateful resource.
{
  const r = classifyPlan(fixture('delete-nonstateful-prod.json'))
  check('delete-nonstateful-prod: production from before tags', r.verdict === 'fail' && r.findings[0].type === 'destructive_production')
}

// before and after tags are parsed and kept per side.
{
  const changes = fixture('replace-retag-prod-to-dev.json')
  check('parse: beforeTags and afterTags kept separate', changes[0].beforeTags.Environment === 'prod' && changes[0].afterTags.Environment === 'dev')
}

// A leading BOM (Windows / PowerShell `terraform show -json >` output) must not
// break parsing — it surfaced as a hard parse failure on a real harvested plan.
{
  const withBom = '﻿' + fs.readFileSync(path.join(__dirname, 'fixtures', 'delete-db.json'), 'utf8')
  const r = classifyPlan(parsePlan(withBom))
  check('bom-prefixed plan: parses and still gates', r.verdict === 'fail' && r.stats.criticalCount === 1)
}

// ── per-change-kind counts for the plan digest ─────────────────────────────

{
  const r = classifyPlan(fixture('create-only.json')).stats
  check('counts create-only: created 1, rest 0', r.created === 1 && r.updated === 0 && r.replaced === 0 && r.destroyed === 0)
}
{
  const r = classifyPlan(fixture('safe-update.json')).stats
  check('counts safe-update: updated 1, rest 0', r.updated === 1 && r.created === 0 && r.replaced === 0 && r.destroyed === 0)
}
{
  const r = classifyPlan(fixture('replace-volume.json')).stats
  check('counts replace-volume: replaced 1, destroyed 0', r.replaced === 1 && r.destroyed === 0)
}
{
  const r = classifyPlan(fixture('delete-db.json')).stats
  check('counts delete-db: destroyed 1, replaced 0', r.destroyed === 1 && r.replaced === 0)
}
{
  // A replace is add+destroy in Terraform, but the digest counts it as its own
  // kind: the read data source and the no-op are excluded from all four counts.
  const r = classifyPlan(fixture('large-mixed-plan.json')).stats
  check('counts large-mixed: 1 add, 1 change, 1 replace, 1 destroy', r.created === 1 && r.updated === 1 && r.replaced === 1 && r.destroyed === 1)
}

// ── downtime / disruption signal (informational, low-noise) ────────────────

{
  const r = classifyPlan(fixture('safe-update.json'))
  check('disruption safe-update: none', r.disruptions.length === 0)
}
{
  // A stateful EBS replace is already a data-loss block; it is deliberately not
  // disruptive-listed, so it never carries a second, redundant downtime note.
  const r = classifyPlan(fixture('replace-volume.json'))
  check('disruption replace-volume: none (stateful, not double-flagged)', r.disruptions.length === 0)
}
{
  // Replacing a compute resource surfaces a disruption note, adds NO finding, and
  // does not block: presence without noise.
  const r = classifyPlan(fixture('replace-instance.json'))
  check('disruption replace-instance: surfaced', r.disruptions.some(d => d.type === 'aws_instance'))
  check('disruption replace-instance: no extra finding', r.stats.warningCount === 1 && r.findings.length === 1)
  check('disruption replace-instance: passes (no block)', r.verdict === 'pass')
}

console.log('\n' + '─'.repeat(50))
if (failures === 0) {
  console.log('All plan tests passed')
  process.exit(0)
} else {
  console.log(`${failures} test(s) failed`)
  process.exit(1)
}
