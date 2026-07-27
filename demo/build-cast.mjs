// Builds demo/prodgate.cast (asciicast v2) from the real CLI output, so the demo
// can never drift from what the tool actually prints. Run: node demo/build-cast.mjs
// Then render with demo/render.ps1 (or the commands in demo/README.md).

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Run the real CLI and capture exactly what it prints.
const run = spawnSync(process.execPath, ['dist/cli.js', 'check', 'demo/plan.json', '--commits-file', 'demo/commits.txt'], {
  cwd: root,
  encoding: 'utf8',
})
const output = (run.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, '')

const COLS = 92
const ROWS = 22
const command = 'prodgate check plan.json'

const events = []
let t = 0.0
const push = (dt, data) => { t = +(t + dt).toFixed(3); events.push([t, 'o', data]) }

// Shell prompt, then type the command one character at a time.
push(0.4, '$ ')
for (const ch of command) push(0.05, ch)
push(0.5, '\r\n')

// Stream the real output line by line so it reads like a live run.
const lines = output.split('\n')
for (const line of lines) push(0.11, line + '\r\n')

// Hold on the final frame.
push(2.8, '')

const header = { version: 2, width: COLS, height: ROWS, title: 'prodgate', env: { TERM: 'xterm-256color' } }
const cast = [JSON.stringify(header), ...events.map(e => JSON.stringify(e))].join('\n') + '\n'
writeFileSync(join(here, 'prodgate.cast'), cast)
console.log(`wrote demo/prodgate.cast (${lines.length} output lines, ~${t.toFixed(1)}s)`)
