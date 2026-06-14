/**
 * case6.ts
 *
 * Smoke test for Case 6: shadowed route detection.
 *
 * Creates a synthetic Express app where an unprotected route appears
 * before a protected route on the same path. Verifies prodgate catches
 * it as CRITICAL.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scanRepo } from '../src/extract'
import { diffRoutes } from '../src/diff'
import { formatHuman } from '../src/output'

const BEFORE_ROUTES = `
const express = require('express')
const router = express.Router()
const { requireAuth } = require('../middleware/auth')

router.get('/users', requireAuth, getUsers)

module.exports = router
`

const AFTER_ROUTES = `
const express = require('express')
const router = express.Router()
const { requireAuth } = require('../middleware/auth')

router.get('/users', quickGetUsers)
router.get('/users', requireAuth, getUsers)

module.exports = router
`

const AUTH_MIDDLEWARE = `
const requireAuth = (req, res, next) => next()
module.exports = { requireAuth }
`

function createRepo(routesCode: string, dir: string) {
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'middleware'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'users.js'), routesCode)
  fs.writeFileSync(path.join(dir, 'src', 'middleware', 'auth.js'), AUTH_MIDDLEWARE)
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodgate-case6-'))
  const beforeDir = path.join(tmpDir, 'before')
  const afterDir = path.join(tmpDir, 'after')

  try {
    createRepo(BEFORE_ROUTES, beforeDir)
    createRepo(AFTER_ROUTES, afterDir)

    const beforeResult = await scanRepo(beforeDir)
    const afterResult = await scanRepo(afterDir)

    const result = diffRoutes(
        beforeResult.routes,
        afterResult.routes,
        beforeResult.mounts,
        afterResult.mounts,
        []
)

    console.log('\nCase 6: Shadowed route detection')
    console.log('─'.repeat(50))
    console.log(formatHuman(result))

    const caught = result.verdict === 'fail' &&
    result.findings.some(f =>
        f.severity === 'CRITICAL' &&
        f.route.path === '/users' &&
        f.route.method === 'get'
  )

    if (caught) {
      console.log('[PASS] Case 6 caught correctly')
      process.exit(0)
    } else {
      console.log('[FAIL] Case 6 not caught')
      process.exit(1)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

main()