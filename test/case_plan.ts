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
  check('approved: pass, finding still reported', r.verdict === 'pass' && r.approved && r.findings.length === 1)
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
  check('computed-unknown-update: pass, no false mutation flag', r.verdict === 'pass' && r.findings.length === 0)
}

// Large mixed plan: data source skipped, no-ops ignored, prod replace caught,
// dev teardown stays a warning
{
  const r = classifyPlan(fixture('large-mixed-plan.json'))
  check('large-mixed-plan: 1 critical (prod cache replace), 1 warning (dev lambda)', r.verdict === 'fail' && r.stats.criticalCount === 1 && r.stats.warningCount === 1 && r.findings.some(f => f.type === 'destructive_stateful' && f.action === 'replace'))
}

console.log('\n' + '─'.repeat(50))
if (failures === 0) {
  console.log('All plan tests passed')
  process.exit(0)
} else {
  console.log(`${failures} test(s) failed`)
  process.exit(1)
}
