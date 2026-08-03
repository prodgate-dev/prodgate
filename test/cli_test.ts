/**
 * cli_test.ts
 *
 * Process-level tests for the built CLI. These run `dist/cli.js` as a real process
 * and assert exit codes, output modes, invalid-input handling, and config behavior,
 * which the in-process classifier tests cannot cover. Requires a build first
 * (the pretest script handles that).
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let failures = 0
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!cond) failures++
}

const CLI = path.join(__dirname, '..', 'dist', 'cli.js')
const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

type Run = { code: number; stdout: string; stderr: string }
function run(args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

let counter = 0
function writeTmp(content: string): string {
  const p = path.join(os.tmpdir(), `pg-cli-${process.pid}-${counter++}.json`)
  fs.writeFileSync(p, content)
  return p
}
function writeTmpBuffer(buf: Buffer): string {
  const p = path.join(os.tmpdir(), `pg-cli-${process.pid}-${counter++}.json`)
  fs.writeFileSync(p, buf)
  return p
}
function digestOf(args: string[]): string {
  try { return JSON.parse(run(['check', fixture('create-only.json'), '--json', ...args]).stdout).policy.digest } catch { return '' }
}

console.log('\nProdgate CLI behavior')
console.log('─'.repeat(50))

// Exit codes for the core outcomes.
check('enforce + critical exits 1', run(['check', fixture('delete-db.json')]).code === 1)
check('safe plan exits 0', run(['check', fixture('create-only.json')]).code === 0)
check('audit + critical exits 0 with banner', (() => {
  const r = run(['check', fixture('delete-db.json'), '--mode', 'audit'])
  return r.code === 0 && /AUDIT MODE/.test(r.stdout)
})())
check('fail-on never exits 0 on a critical', run(['check', fixture('delete-db.json'), '--fail-on', 'never']).code === 0)
check('fail-on warning exits 1 on a warning-only plan', run(['check', fixture('delete-dev-lambda.json'), '--fail-on', 'warning']).code === 1)

// Invalid input fails closed with exit 2.
check('missing plan file exits 2', run(['check', path.join(os.tmpdir(), 'does-not-exist-xyz.json')]).code === 2)
check('directory path exits 2', run(['check', path.join(__dirname, 'fixtures')]).code === 2)
check('empty file exits 2', run(['check', writeTmp('')]).code === 2)
check('empty object plan exits 2', run(['check', writeTmp('{}')]).code === 2)
check('state-shaped input exits 2', run(['check', writeTmp('{"format_version":"1.0","values":{}}')]).code === 2)
check('json error carries a code', (() => {
  const r = run(['check', writeTmp('{}'), '--json'])
  try { return r.code === 2 && JSON.parse(r.stdout).error.code === 'UNSUPPORTED_FORMAT' } catch { return false }
})())

// Config validation.
check('malformed config exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{ not json')]).code === 2)
check('wrong-typed config exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{"ignore":"foo"}')]).code === 2)
check('unknown config key exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{"nope":true}')]).code === 2)
check('missing named config exits 2', run(['check', fixture('create-only.json'), '--config', path.join(os.tmpdir(), 'no-config-xyz.json')]).code === 2)
check('valid config exits 0', run(['check', fixture('create-only.json'), '--config', writeTmp('{"schemaVersion":1,"mode":"enforce","ignore":["module.x.*"]}')]).code === 0)
check('invalid --mode exits 2', run(['check', fixture('delete-db.json'), '--mode', 'bogus']).code === 2)

// Usage errors are tool errors, not policy blocks, so they must not share exit 1.
check('missing argument exits 2', run(['check']).code === 2)
check('unknown option exits 2', run(['check', fixture('create-only.json'), '--bad-option']).code === 2)
check('invalid --fail-on exits 2', run(['check', fixture('create-only.json'), '--fail-on', 'sometimes']).code === 2)
check('--help exits 0', run(['--help']).code === 0)
check('--version exits 0', run(['--version']).code === 0)
check('invalid --mode with --json returns a structured error', (() => {
  const r = run(['check', fixture('create-only.json'), '--json', '--mode', 'invalid'])
  try { return r.code === 2 && JSON.parse(r.stdout).error.code === 'INVALID_OPTION' } catch { return false }
})())

// A malformed plan must never echo its contents into logs or JSON output.
{
  const secret = writeTmp('SUPER_SECRET_SENTINEL not json')
  const human = run(['check', secret])
  const json = run(['check', secret, '--json'])
  const leaked = (human.stdout + human.stderr + json.stdout + json.stderr).includes('SUPER_SECRET_SENTINEL')
  check('parse errors do not leak plan contents', human.code === 2 && json.code === 2 && !leaked)
}

// A plan that failed to generate must not evaluate as a clean no-change plan.
check('errored plan exits 2', run(['check', writeTmp('{"format_version":"1.2","errored":true,"resource_changes":[]}')]).code === 2)

// Output modes.
check('json envelope separates policy verdict from mode', (() => {
  const r = run(['check', fixture('delete-db.json'), '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 1 && o.enforcement.policyVerdict === 'fail' && o.enforcement.mode === 'enforce' && o.enforcement.wouldBlock === true && typeof o.policy.digest === 'string'
  } catch { return false }
})())
check('json envelope has schema, engine, and plan metadata', (() => {
  const r = run(['check', fixture('delete-db.json'), '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return o.schemaVersion === '1.0' && o.engine.name === 'prodgate' && typeof o.engine.version === 'string' && typeof o.plan.hash === 'string' && o.plan.formatVersion === '1.2'
  } catch { return false }
})())
check('github output is markdown with no ANSI', (() => {
  const r = run(['check', fixture('delete-db.json'), '--github'])
  return /## Prodgate/.test(r.stdout) && !/\x1b\[/.test(r.stdout)
})())
check('github output shows the rule id', run(['check', fixture('delete-db.json'), '--github']).stdout.includes('PG-DESTROY-STATEFUL'))
check('json findings carry rule id, category, confidence, evidence', (() => {
  const r = run(['check', fixture('delete-db.json'), '--json'])
  try {
    const f = JSON.parse(r.stdout).findings[0]
    return f.ruleId === 'PG-DESTROY-STATEFUL' && f.category === 'data_loss' && f.confidence === 'high' && Array.isArray(f.evidence) && f.evidence.length > 0
  } catch { return false }
})())
check('audit json reports would-block via executionOutcome', (() => {
  const r = run(['check', fixture('delete-db.json'), '--mode', 'audit', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 0 && o.enforcement.policyVerdict === 'fail' && o.enforcement.wouldBlock === true && o.enforcement.executionOutcome === 'reported'
  } catch { return false }
})())
check('override envelope records outcome and metadata', (() => {
  const r = run(['check', fixture('delete-db.json'), '--override', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 0 && o.enforcement.executionOutcome === 'overridden' && o.enforcement.override.applied === true
  } catch { return false }
})())
check('envelope findings are severity-sorted', (() => {
  // large-mixed has a critical and a warning; critical must come first.
  const r = run(['check', fixture('large-mixed-plan.json'), '--json'])
  try {
    const f = JSON.parse(r.stdout).findings
    return f.length >= 2 && f[0].severity === 'CRITICAL' && f[f.length - 1].severity === 'WARNING'
  } catch { return false }
})())
check('finding order is stable across resource permutation', (() => {
  const order = (fix: string) => {
    try { return JSON.parse(run(['check', fixture(fix), '--json']).stdout).findings.map((f: any) => `${f.ruleId}@${f.resource.address}`).join(',') } catch { return '' }
  }
  const a = order('large-mixed-plan.json')
  return a !== '' && a === order('large-mixed-permuted.json')
})())
check('clean plan with --override reports allowed and no applied override', (() => {
  const r = run(['check', fixture('create-only.json'), '--override', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 0 && o.enforcement.executionOutcome === 'allowed' && o.enforcement.override === undefined
  } catch { return false }
})())

// UTF-16 encoded plans (Windows tooling) must evaluate the same as UTF-8.
{
  const utf8 = fs.readFileSync(fixture('delete-db.json'), 'utf8')
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')])
  const beInner = Buffer.from(utf8, 'utf16le')
  const be = Buffer.from(beInner)
  for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t }
  const beBuf = Buffer.concat([Buffer.from([0xfe, 0xff]), be])
  check('utf16-le plan evaluates like utf8', run(['check', writeTmpBuffer(le)]).code === 1)
  check('utf16-be plan evaluates like utf8', run(['check', writeTmpBuffer(beBuf)]).code === 1)
}

// Config path and exception reporting.
{
  const cfg = writeTmp('{"schemaVersion":1,"ignore":["module.x.*"]}')
  const jr = run(['check', fixture('create-only.json'), '--config', cfg, '--json'])
  let jsonHasPath = false
  try { jsonHasPath = JSON.parse(jr.stdout).policy.configPath === cfg } catch { jsonHasPath = false }
  check('json contains configPath', jsonHasPath)
  check('human prints the config path', run(['check', fixture('create-only.json'), '--config', cfg]).stdout.includes(cfg))
}
{
  const cfg = writeTmp('{"allowDestruction":["aws_db_instance.main"]}')
  const hr = run(['check', fixture('delete-db.json'), '--config', cfg])
  check('human names the matched exception', /aws_db_instance\.main/.test(hr.stdout) && /exception/i.test(hr.stdout))
  const jr = run(['check', fixture('delete-db.json'), '--config', cfg, '--json'])
  let suppOk = false
  try {
    const s = JSON.parse(jr.stdout).suppressions[0]
    suppOk = s.address === 'aws_db_instance.main' && s.matchedBy === 'aws_db_instance.main'
  } catch { suppOk = false }
  check('json contains suppression address and matchedBy', suppOk)
}

// Policy digest is deterministic and changes with the effective policy.
{
  check('same effective policy gives the same digest', digestOf([]) !== '' && digestOf([]) === digestOf([]))
  check('changing mode changes the digest', digestOf([]) !== digestOf(['--mode', 'audit']))
  check('changing fail-on changes the digest', digestOf([]) !== digestOf(['--fail-on', 'warning']))
  const cfg = writeTmp('{"ignore":["a.*"]}')
  check('changing an exception changes the digest', digestOf([]) !== digestOf(['--config', cfg]))

  // Semantic equivalence: policies that mean the same thing hash the same.
  const reordered = digestOf(['--config', writeTmp('{"ignore":["b.*","a.*","a.*"]}')])
  const canonical = digestOf(['--config', writeTmp('{"ignore":["a.*","b.*"]}')])
  check('digest: reordered and duplicated patterns are equivalent', reordered !== '' && reordered === canonical)
  check('digest: allowDestroy alias equals allowDestruction', digestOf(['--config', writeTmp('{"allowDestroy":["x.y"]}')]) === digestOf(['--config', writeTmp('{"allowDestruction":["x.y"]}')]))
  check('digest: object key order does not matter', digestOf(['--config', writeTmp('{"mode":"audit","failOn":"warning"}')]) === digestOf(['--config', writeTmp('{"failOn":"warning","mode":"audit"}')]))
  check('digest: a CLI override matches the equivalent config', digestOf(['--config', writeTmp('{"mode":"audit"}'), '--mode', 'enforce']) === digestOf(['--config', writeTmp('{"mode":"enforce"}')]))
}

// coverage command.
check('coverage --json lists rules with ids', (() => {
  const r = run(['coverage', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return o.entries.length > 10 && o.policyVersion === 'aws-default-v1' && o.entries.some((e: any) => e.ruleId === 'PG-AWS-RDS-PUBLIC')
  } catch { return false }
})())
check('coverage human output lists a resource type', run(['coverage']).stdout.includes('aws_db_instance'))
check('coverage --provider aws only filters, does not mutate', (() => {
  try {
    const all = JSON.parse(run(['coverage', '--json']).stdout).entries
    const aws = JSON.parse(run(['coverage', '--provider', 'aws', '--json']).stdout).entries
    return all.length === aws.length && JSON.stringify(all) === JSON.stringify(aws)
  } catch { return false }
})())
check('coverage --provider gcp is empty', (() => {
  try { return JSON.parse(run(['coverage', '--provider', 'gcp', '--json']).stdout).entries.length === 0 } catch { return false }
})())
check('coverage --json is stable across runs', run(['coverage', '--json']).stdout === run(['coverage', '--json']).stdout)

// explain, doctor, and diagnostics.
check('explain describes a known rule', (() => {
  const r = run(['explain', 'PG-AWS-RDS-PUBLIC'])
  return r.code === 0 && /exposure/.test(r.stdout) && /publicly_accessible/.test(r.stdout) && /Limitation/.test(r.stdout)
})())
check('explain is case insensitive', run(['explain', 'pg-aws-rds-public']).code === 0)
check('explain --json returns the rule entry', (() => {
  const r = run(['explain', 'PG-AWS-SG-WORLD-OPEN', '--json'])
  try { return r.code === 0 && JSON.parse(r.stdout).ruleId === 'PG-AWS-SG-WORLD-OPEN' } catch { return false }
})())
check('explain on an unknown rule exits 2', run(['explain', 'PG-NOPE']).code === 2)
// Every rule the classifier can emit must be explainable.
check('explain covers the generic destruction rules', ['PG-DESTROY-STATEFUL', 'PG-DESTROY-STATEFUL-NONPROD', 'PG-DESTROY-PROD', 'PG-DESTROY-OTHER', 'PG-DISRUPTION-NOTE'].every(id => run(['explain', id]).code === 0))
// A grouped rule must not borrow the first resource type's rationale.
check('explain gives a grouped rule its own rationale and per-type detail', (() => {
  const r = run(['explain', 'PG-DESTROY-STATEFUL'])
  return r.code === 0 && !/Why:.*holds the database storage/.test(r.stdout) && /Applies to \d+ resource type/.test(r.stdout) && /aws_s3_bucket/.test(r.stdout)
})())
check('explain --json returns a rule with entries', (() => {
  const r = run(['explain', 'PG-DESTROY-STATEFUL', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return o.ruleId === 'PG-DESTROY-STATEFUL' && Array.isArray(o.entries) && o.entries.length > 5
  } catch { return false }
})())

check('doctor reports a healthy setup and exits 0', (() => {
  const r = run(['doctor', fixture('delete-db.json')])
  return r.code === 0 && /Node/.test(r.stdout) && /No problems found/.test(r.stdout)
})())
check('doctor with no plan argument exits 0', run(['doctor']).code === 0)
// A valid plan with nothing to evaluate is a note, not a problem.
check('doctor treats a valid no-change plan as a note and exits 0', (() => {
  const r = run(['doctor', fixture('golden/no-change.tfplan.json')])
  return r.code === 0 && /\[note\]/.test(r.stdout) && /nothing to evaluate/.test(r.stdout)
})())
// A named input that is missing or unusable is a blocker, so it exits 2.
check('doctor exits 2 on a missing named plan', run(['doctor', path.join(os.tmpdir(), 'nope-doctor.json')]).code === 2)
check('doctor exits 2 on an unparsable plan', (() => {
  const r = run(['doctor', writeTmp('{}')])
  return r.code === 2 && /\[error\]/.test(r.stdout)
})())
check('doctor exits 2 on a missing named config', run(['doctor', '--config', path.join(os.tmpdir(), 'nope-cfg.json')]).code === 2)

check('diagnostics emits sanitized metadata only', (() => {
  const r = run(['diagnostics', fixture('golden/create-exposures.tfplan.json')])
  try {
    const o = JSON.parse(r.stdout)
    const text = r.stdout
    // Rule ids and resource types are fine; addresses, names, and values are not.
    const leaks = ['aws_db_instance.public', 'example-open-bucket', 'dbadmin', 'PLACEHOLDER']
    return r.code === 0 && o.findings.length === 3 && o.policy.digest.startsWith('sha256:') && !leaks.some(l => text.includes(l))
  } catch { return false }
})())
check('diagnostics --finding filters to one rule', (() => {
  const r = run(['diagnostics', fixture('golden/create-exposures.tfplan.json'), '--finding', 'PG-AWS-RDS-PUBLIC'])
  try {
    const f = JSON.parse(r.stdout).findings
    return f.length === 1 && f[0].ruleId === 'PG-AWS-RDS-PUBLIC'
  } catch { return false }
})())
check('diagnostics on a missing plan exits 2', run(['diagnostics', path.join(os.tmpdir(), 'nope-xyz.json')]).code === 2)
// A filter that matches nothing must be reported, not returned as an empty list.
check('diagnostics --finding with an unknown rule exits 2', (() => {
  const r = run(['diagnostics', fixture('golden/create-exposures.tfplan.json'), '--finding', 'PG-NOPE'])
  return r.code === 2 && /Unknown rule/.test(r.stderr)
})())
check('diagnostics --finding with a known but untriggered rule exits 2', (() => {
  const r = run(['diagnostics', fixture('golden/create-exposures.tfplan.json'), '--finding', 'PG-DESTROY-STATEFUL'])
  return r.code === 2 && /did not produce a finding/.test(r.stderr) && /Rules present/.test(r.stderr)
})())

// --outputs-file writes the CI key=value pairs the Action exposes.
{
  const outFile = path.join(os.tmpdir(), `pg-outputs-${process.pid}-${counter++}.txt`)
  run(['check', fixture('delete-db.json'), '--outputs-file', outFile])
  let text = ''
  try { text = fs.readFileSync(outFile, 'utf8') } catch { text = '' }
  const keys = ['policy-verdict', 'would-block', 'execution-outcome', 'enforcement-mode', 'exit-code', 'critical-count', 'warning-count', 'plan-hash', 'policy-digest', 'report-path', 'engine-version']
  check('outputs-file has every declared key', keys.every(k => new RegExp('(^|\\n)' + k + '=').test(text)))
  check('outputs-file values are correct for a blocked plan',
    /policy-verdict=fail/.test(text) && /would-block=true/.test(text) && /execution-outcome=blocked/.test(text) && /exit-code=1/.test(text) && /critical-count=1/.test(text) && /engine-version=/.test(text))
}

console.log('\n' + '─'.repeat(50))
if (failures === 0) {
  console.log('All CLI tests passed')
  process.exit(0)
} else {
  console.log(`${failures} CLI test(s) failed`)
  process.exit(1)
}
