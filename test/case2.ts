/**
 * case2.ts
 *
 * Smoke test for Case 2: router-level auth removal detection.
 *
 * Creates a synthetic Express app with router-level auth middleware,
 * removes the middleware from the mount point, and verifies prodgate
 * catches it as CRITICAL.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scanRepo } from '../src/extract'
import { diffRoutes } from '../src/diff'
import { formatHuman } from '../src/output'

const BEFORE_APP = `
const express = require('express')
const app = express()
const adminRouter = require('./routes/admin')
const { requireAuth, requireAdmin } = require('./middleware/auth')

app.use('/admin', requireAuth, requireAdmin, adminRouter)
`

const AFTER_APP = `
const express = require('express')
const app = express()
const adminRouter = require('./routes/admin')
const { requireAuth, requireAdmin } = require('./middleware/auth')

app.use('/admin', adminRouter)
`

const ADMIN_ROUTES = `
const express = require('express')
const router = express.Router()

router.get('/users', getUsers)
router.post('/users', createUser)
router.get('/audit-logs', getAuditLogs)

module.exports = router
`

function createRepo(appCode: string, dir: string) {
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'middleware'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), appCode)
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'admin.js'), ADMIN_ROUTES)
  fs.writeFileSync(path.join(dir, 'src', 'middleware', 'auth.js'),
    `const requireAuth = (req, res, next) => next()\nconst requireAdmin = (req, res, next) => next()\nmodule.exports = { requireAuth, requireAdmin }`)
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodgate-case2-'))
  const beforeDir = path.join(tmpDir, 'before')
  const afterDir = path.join(tmpDir, 'after')

  try {
    createRepo(BEFORE_APP, beforeDir)
    createRepo(AFTER_APP, afterDir)

    const beforeResult = await scanRepo(beforeDir)
    const afterResult = await scanRepo(afterDir)

    const result = diffRoutes(
      beforeResult.routes,
      afterResult.routes,
      beforeResult.mounts,
      afterResult.mounts,
      []
    )

    console.log('\nCase 2: Router-level auth removal')
    console.log('─'.repeat(50))
    console.log(formatHuman(result))


    const caught = result.verdict === 'fail' &&
    result.findings.some(f =>
      f.severity === 'CRITICAL' &&
      (f.deltaType === 'router_auth_removed' || f.deltaType === 'protected_to_unprotected') &&
      f.route.path === '/admin'
    )

    if (caught) {
      console.log('[PASS] Case 2 caught correctly')
      process.exit(0)
    } else {
      console.log('[FAIL] Case 2 not caught')
      process.exit(1)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

main()