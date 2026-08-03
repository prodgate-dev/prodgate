/**
 * fuzz_test.ts
 *
 * Seeded property test over the parser and classifier. It asserts the invariants that
 * matter for a gate: arbitrary input never crashes with an unexpected error, and an
 * input that is not a well formed plan never produces a passing verdict.
 *
 * The generator is seeded so a failure is reproducible: PRODGATE_FUZZ_SEED=<n> npm test
 */

import { parsePlanFull, PlanInputError } from '../src/plan'
import { classifyPlan } from '../src/classify'

let failures = 0
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!cond) failures++
}

// Small deterministic PRNG so runs are reproducible from a seed.
function makeRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const SEED = Number(process.env.PRODGATE_FUZZ_SEED ?? 20260729)
const ITERATIONS = Number(process.env.PRODGATE_FUZZ_ITERATIONS ?? 5000)
const rnd = makeRandom(SEED)

function pick<T>(items: T[]): T {
  return items[Math.floor(rnd() * items.length)]
}

const SCALARS: any[] = [null, true, false, 0, 1, -1, '', 'x', 'managed', 'data', 'create', 'delete', 'read', [], {}, 'prod']
const ACTION_SETS: any[] = [
  ['create'], ['delete'], ['update'], ['no-op'], ['read'],
  ['delete', 'create'], ['create', 'delete'], ['create', 'update'], ['frobnicate'], [], 'notanarray',
]

function randomChange(): any {
  const change: any = {}
  if (rnd() < 0.9) change.actions = pick(ACTION_SETS)
  if (rnd() < 0.8) change.before = pick(SCALARS)
  if (rnd() < 0.8) change.after = pick(SCALARS)
  if (rnd() < 0.3) change.after_unknown = pick(SCALARS)
  return change
}

function randomResourceChange(): any {
  const rc: any = {}
  if (rnd() < 0.9) rc.address = pick(['aws_db_instance.main', 'a.b', '', 'module.x.aws_s3_bucket.y'])
  if (rnd() < 0.9) rc.type = pick(['aws_db_instance', 'aws_s3_bucket', 'aws_security_group', '', 'google_sql_database_instance'])
  if (rnd() < 0.9) rc.name = pick(['main', 'b', ''])
  if (rnd() < 0.9) rc.mode = pick(['managed', 'data', 'bogus', ''])
  if (rnd() < 0.95) rc.change = rnd() < 0.9 ? randomChange() : pick(SCALARS)
  return rc
}

function randomDoc(): any {
  const doc: any = {}
  if (rnd() < 0.85) doc.format_version = pick(['1.2', '1.0', '0.2', '99.0', '', 5, null])
  if (rnd() < 0.5) doc.terraform_version = pick(['1.9.8', 5, null])
  if (rnd() < 0.7) {
    const n = Math.floor(rnd() * 3)
    doc.resource_changes = rnd() < 0.9 ? Array.from({ length: n }, randomResourceChange) : pick(SCALARS)
  }
  for (const key of ['configuration', 'planned_values', 'prior_state', 'variables', 'output_changes', 'checks']) {
    if (rnd() < 0.25) doc[key] = pick(SCALARS)
  }
  for (const key of ['resource_drift', 'relevant_attributes']) {
    if (rnd() < 0.15) doc[key] = pick(SCALARS)
  }
  if (rnd() < 0.15) doc.errored = pick([true, false, 'yes', null])
  return doc
}

console.log('\nProdgate parser and classifier properties')
console.log('─'.repeat(50))
console.log(`  seed ${SEED}, ${ITERATIONS} iterations`)

let evaluated = 0
let rejected = 0
let unexpected: { input: string; error: string } | null = null

for (let i = 0; i < ITERATIONS && !unexpected; i++) {
  const doc = randomDoc()
  const text = JSON.stringify(doc)
  try {
    const parsed = parsePlanFull(text)
    // Anything that parses must classify without throwing, and every change it kept
    // must be a managed resource with a usable identity.
    const result = classifyPlan(parsed.changes)
    evaluated++
    if (!parsed.changes.every(c => c.address.length > 0 && c.type.length > 0)) {
      unexpected = { input: text, error: 'accepted a change without an address or type' }
    } else if (result.verdict !== 'pass' && result.verdict !== 'fail') {
      unexpected = { input: text, error: `produced a non-verdict: ${String(result.verdict)}` }
    }
  } catch (e) {
    // Only the typed input error is acceptable. A TypeError here would mean a crash
    // on hostile input rather than a clean rejection.
    if (e instanceof PlanInputError) rejected++
    else unexpected = { input: text, error: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

check(`no unexpected exceptions over ${ITERATIONS} documents`, unexpected === null)
if (unexpected) {
  console.log(`    input: ${unexpected.input.slice(0, 400)}`)
  console.log(`    error: ${unexpected.error}`)
}
check('the generator produced both accepted and rejected documents', evaluated > 0 && rejected > 0)

// Malformed documents must never evaluate to a passing verdict.
const MALFORMED = [
  '{}',
  '[]',
  '{"resource_changes":[]}',
  '{"format_version":"1.2","configuration":false}',
  '{"format_version":"1.2","planned_values":[]}',
  '{"format_version":"1.2","errored":true,"resource_changes":[]}',
  '{"format_version":"1.2","resource_changes":[{"address":"a.b","type":"a","name":"b","mode":"managed","change":{"actions":["read"],"before":null,"after":null}}]}',
  '{"format_version":"99.0","resource_changes":[]}',
  'not json at all',
]
let leaked = 0
for (const text of MALFORMED) {
  try {
    const parsed = parsePlanFull(text)
    classifyPlan(parsed.changes)
    leaked++
    console.log(`    accepted malformed input: ${text.slice(0, 120)}`)
  } catch (e) {
    if (!(e instanceof PlanInputError)) {
      leaked++
      console.log(`    wrong error type for: ${text.slice(0, 120)}`)
    }
  }
}
check('no malformed document is accepted', leaked === 0)

// Explicit schema properties for the optional top-level sections. Random generation
// alone cannot tell which shape is correct, so the expected type is asserted here.
const OBJECT_SECTIONS = ['configuration', 'planned_values', 'prior_state', 'variables', 'output_changes']
const ARRAY_SECTIONS = ['resource_drift', 'relevant_attributes', 'checks']
const WRONG_FOR_OBJECT = ['null', '[]', '"s"', '5', 'true']
const WRONG_FOR_ARRAY = ['null', '{}', '"s"', '5', 'true']

function parses(body: string): boolean {
  try {
    parsePlanFull(body)
    return true
  } catch {
    return false
  }
}

let schemaFailures = 0
for (const key of OBJECT_SECTIONS) {
  if (!parses(`{"format_version":"1.2","resource_changes":[],"${key}":{}}`)) {
    schemaFailures++
    console.log(`    object section ${key} rejected a valid object`)
  }
  for (const wrong of WRONG_FOR_OBJECT) {
    if (parses(`{"format_version":"1.2","resource_changes":[],"${key}":${wrong}}`)) {
      schemaFailures++
      console.log(`    object section ${key} accepted ${wrong}`)
    }
  }
}
for (const key of ARRAY_SECTIONS) {
  if (!parses(`{"format_version":"1.2","resource_changes":[],"${key}":[]}`)) {
    schemaFailures++
    console.log(`    array section ${key} rejected a valid array`)
  }
  for (const wrong of WRONG_FOR_ARRAY) {
    if (parses(`{"format_version":"1.2","resource_changes":[],"${key}":${wrong}}`)) {
      schemaFailures++
      console.log(`    array section ${key} accepted ${wrong}`)
    }
  }
}
check('optional sections accept their type and reject every other shape', schemaFailures === 0)

// A plan carrying every optional section, each well formed, must parse.
{
  const full = '{"format_version":"1.2","terraform_version":"1.9.8","resource_changes":[],'
    + OBJECT_SECTIONS.map(k => `"${k}":{}`).join(',') + ','
    + ARRAY_SECTIONS.map(k => `"${k}":[]`).join(',') + '}'
  check('a plan with every optional section present parses', parses(full))
}

console.log('\n' + '─'.repeat(50))
if (failures === 0) {
  console.log('All property tests passed')
  process.exit(0)
} else {
  console.log(`${failures} property test(s) failed (seed ${SEED})`)
  process.exit(1)
}
