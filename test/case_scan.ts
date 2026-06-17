/**
 * case_scan.ts
 *
 * Tests `scan` classification on a synthetic Express app: a genuine unprotected
 * mutation (CRITICAL), an unprotected read (WARNING), a custom-named guard that
 * must land in "uncertain" rather than "unprotected", a public-by-convention
 * route, a mount-protected route, and the path-boundary fix (a /admin mount must
 * not protect an unrelated /administrators route).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scanRepo } from '../src/extract'
import { scanRoutes } from '../src/scan'
import { effectiveMiddlewares, pathUnderMount } from '../src/diff'

const APP = `
const express = require('express')
const { requireAuth } = require('./mw')
const ordersRouter = require('./routes/orders')
const itemsRouter = require('./routes/items')
const app = express()
app.use('/orders', requireAuth, ordersRouter)
app.use('/items', itemsRouter)
`

const ORDERS = `
const express = require('express')
const router = express.Router()
router.post('/refund', (req, res) => res.json({}))
module.exports = router
`

const ITEMS = `
const express = require('express')
const { ensureLoggedIn } = require('../mw')
const router = express.Router()
router.delete('/:id', (req, res) => res.json({}))
router.get('/list', (req, res) => res.json({}))
router.get('/secret', ensureLoggedIn, (req, res) => res.json({}))
router.post('/login', (req, res) => res.json({}))
module.exports = router
`

function createRepo(dir: string) {
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), APP)
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'orders.js'), ORDERS)
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'items.js'), ITEMS)
  fs.writeFileSync(path.join(dir, 'src', 'mw.js'),
    `const requireAuth = (req,res,next)=>next()\nconst ensureLoggedIn = (req,res,next)=>next()\nmodule.exports = { requireAuth, ensureLoggedIn }`)
}

function check(label: string, cond: boolean): boolean {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  return cond
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prodgate-scan-'))
  const repo = path.join(tmp, 'app')
  try {
    createRepo(repo)
    const { routes, mounts } = await scanRepo(repo)
    const result = scanRoutes(routes, mounts)
    const s = result.stats

    console.log('\nCase scan: single-tree classification')
    console.log('─'.repeat(50))

    const find = (m: string, p: string) =>
      result.routes.find(r => r.method === m && r.path === p)

    let ok = true
    ok = check('DELETE /items/:id is an unprotected mutation', s.unprotectedMutations === 1 && find('delete', '/items/:id')?.state === 'unprotected') && ok
    ok = check('GET /items/list is an unprotected read', s.unprotectedReads === 1 && find('get', '/items/list')?.state === 'unprotected') && ok
    ok = check('GET /items/secret (ensureLoggedIn) is uncertain, not unprotected', find('get', '/items/secret')?.state === 'uncertain' && s.uncertain === 1) && ok
    ok = check('POST /items/login is public by convention', s.publicByConvention === 1 && find('post', '/items/login')?.likelyPublic === true) && ok
    ok = check('POST /orders/refund is protected by mount', find('post', '/orders/refund')?.state === 'protected') && ok

    // Boundary fix: /admin mount must not protect /administrators.
    ok = check('pathUnderMount(/administrators,/admin) is false', pathUnderMount('/administrators', '/admin') === false) && ok
    const synthetic: any = { file: 'x', method: 'get', path: '/administrators', middlewares: [], handler: 'h', line: 1 }
    const adminMount: any = [{ file: 'app', path: '/admin', middlewares: ['requireAuth'], routerName: 'adminRouter', line: 1 }]
    ok = check('/administrators does not inherit /admin auth', effectiveMiddlewares(synthetic, adminMount).length === 0) && ok

    if (ok) {
      console.log('\n[PASS] Case scan classification correct')
      process.exit(0)
    } else {
      console.log('\n[FAIL] Case scan classification wrong')
      process.exit(1)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main()
