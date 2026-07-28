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
check('empty object plan exits 2', run(['check', writeTmp('{}')]).code === 2)
check('state-shaped input exits 2', run(['check', writeTmp('{"format_version":"1.0","values":{}}')]).code === 2)
check('json error carries a code', (() => {
  const r = run(['check', writeTmp('{}'), '--json'])
  try { return r.code === 2 && JSON.parse(r.stdout).error.code === 'UNRECOGNIZED_DOCUMENT' } catch { return false }
})())

// Config validation.
check('malformed config exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{ not json')]).code === 2)
check('wrong-typed config exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{"ignore":"foo"}')]).code === 2)
check('unknown config key exits 2', run(['check', fixture('create-only.json'), '--config', writeTmp('{"nope":true}')]).code === 2)
check('missing named config exits 2', run(['check', fixture('create-only.json'), '--config', path.join(os.tmpdir(), 'no-config-xyz.json')]).code === 2)
check('valid config exits 0', run(['check', fixture('create-only.json'), '--config', writeTmp('{"schemaVersion":1,"mode":"enforce","ignore":["module.x.*"]}')]).code === 0)
check('invalid --mode exits 2', run(['check', fixture('delete-db.json'), '--mode', 'bogus']).code === 2)

// Output modes.
check('json envelope separates policy verdict from mode', (() => {
  const r = run(['check', fixture('delete-db.json'), '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 1 && o.policyVerdict === 'fail' && o.enforcementMode === 'enforce' && o.wouldBlock === true && typeof o.policyDigest === 'string'
  } catch { return false }
})())
check('github output is markdown with no ANSI', (() => {
  const r = run(['check', fixture('delete-db.json'), '--github'])
  return /## Prodgate/.test(r.stdout) && !/\x1b\[/.test(r.stdout)
})())
check('audit json reports wouldBlock without failing', (() => {
  const r = run(['check', fixture('delete-db.json'), '--mode', 'audit', '--json'])
  try {
    const o = JSON.parse(r.stdout)
    return r.code === 0 && o.policyVerdict === 'fail' && o.wouldBlock === true && o.verdict === 'pass'
  } catch { return false }
})())

console.log('\n' + '─'.repeat(50))
if (failures === 0) {
  console.log('All CLI tests passed')
  process.exit(0)
} else {
  console.log(`${failures} CLI test(s) failed`)
  process.exit(1)
}
