import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { scanRepo, extractRoutes } from '../src/extract'
import { diffRoutes } from '../src/diff'
import { formatHuman } from '../src/output'
import * as parser from '@babel/parser'
import traverse from '@babel/traverse'

//Helpers

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function findRouteFiles(repoPath: string): string[] {
  const results: string[] = []

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', 'coverage', '__tests__'].includes(entry.name)) continue
        walk(fullPath)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        const code = fs.readFileSync(fullPath, 'utf8')
        const hasRouterPattern = /\.(get|post|put|delete|patch|use)\s*\(/.test(code)
        const hasExpressImport = /require\s*\(\s*['"]express['"]|from\s*['"]express['"]/.test(code)
        const hasRouterVar = /Router\(\)|express\.Router/.test(code)
        const hasTestPatterns = /describe\s*\(|it\s*\(|test\s*\(|supertest|jest\./.test(code)
        if (hasRouterPattern && (hasExpressImport || hasRouterVar) && !hasTestPatterns) {
          results.push(fullPath)
        }
      }
    }
  }

  walk(repoPath)
  return results
}


function injectRegression(filePath: string): { success: boolean, description: string } {
  const code = fs.readFileSync(filePath, 'utf8')

  let ast: any
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript']
    })
  } catch (e) {
    return { success: false, description: 'Could not parse file' }
  }

  // Prefer routes with auth-looking middleware
let target: { start: number, end: number, replacement: string } | null = null
let fallbackTarget: { start: number, end: number, replacement: string } | null = null

const AUTH_PATTERN = /auth|require|guard|protect|verify|session|jwt|token|permission|role|super/i

traverse(ast, {
  CallExpression(nodePath) {
    const callee = nodePath.node.callee
    if (callee.type !== 'MemberExpression') return
    if (callee.property.type !== 'Identifier') return
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(callee.property.name)) return

    const args = nodePath.node.arguments
    if (args.length < 3) return
    if (args[0].type !== 'StringLiteral') return

    const middlewareArgs = args.slice(1, -1)
    if (middlewareArgs.length === 0) return

    const pathArg = code.slice(args[0].start!, args[0].end!)
    const handlerArg = code.slice(args[args.length - 1].start!, args[args.length - 1].end!)
    const calleeStr = code.slice(callee.start!, callee.end!)
    const replacement = `${calleeStr}(${pathArg}, ${handlerArg})`

    const entry = {
      start: nodePath.node.start!,
      end: nodePath.node.end!,
      replacement
    }

    // Check if any middleware looks like auth
    const middlewareNames = middlewareArgs.map((arg: any) => {
      if (arg.type === 'Identifier') return arg.name
      if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') return arg.callee.name
      return ''
    })

    const hasAuthMiddleware = middlewareNames.some(n => AUTH_PATTERN.test(n))

    if (hasAuthMiddleware && !target) {
      target = entry
    } else if (!fallbackTarget) {
      fallbackTarget = entry
    }
  }
})

const chosen = target ?? fallbackTarget

if (!chosen) {
  return { success: false, description: 'No injectable pattern found' }
}

const modified = code.slice(0, chosen.start) + chosen.replacement + code.slice(chosen.end)
fs.writeFileSync(filePath, modified)
return { success: true, description: `Removed middleware from ${path.basename(filePath)}` } 
}
//Test Runner

type TestResult = {
  repo: string
  passed: boolean
  reason: string
  routesFound: number
  output?: string
}

async function runSmokeTest(repoPath: string): Promise<TestResult> {
  const repoName = path.basename(repoPath)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `prodgate-smoke-`))
  const afterPath = path.join(tmpDir, 'after')

  try {
    // scan original repo
    const beforeResult = await scanRepo(repoPath)
    const beforeRoutes = beforeResult.routes

    if (beforeRoutes.length === 0) {
      return {
        repo: repoName,
        passed: false,
        reason: 'No routes found — extractor may not support this repo structure',
        routesFound: 0
      }
    }

    //copy repo to temp dir
    copyDir(repoPath, afterPath)

    //find route files in the copy and inject a regression
    const routeFiles = findRouteFiles(afterPath)

    let injected = false
    let injectionDescription = ''

    for (const file of routeFiles) {
      const result = injectRegression(file)
      if (result.success) {
        injected = true
        injectionDescription = result.description
        break
      }
    }

    if (!injected) {
      return {
        repo: repoName,
        passed: false,
        reason: `Could not inject regression — no injectable middleware pattern found in ${routeFiles.length} route files`,
        routesFound: beforeRoutes.length
      }
    }

    // Scan modified repo and diff
    const afterResult = await scanRepo(afterPath)
    const ignorePaths = [
      ...(beforeResult.config.ignore ?? []),
      ...(afterResult.config.ignore ?? [])
    ]
    const result = diffRoutes(
      beforeRoutes,
      afterResult.routes,
      beforeResult.mounts,
      afterResult.mounts,
      ignorePaths
    )

    


    // Assert FAIL with at least one CRITICAL
    const caught = result.verdict === 'fail' && result.findings.some(f => f.severity === 'CRITICAL')

    return {
      repo: repoName,
      passed: caught,
      reason: caught
        ? `Caught regression (${injectionDescription})`
        : `Failed to catch regression (${injectionDescription}) — verdict was ${result.verdict}, criticals: ${result.stats.criticalCount}`,
      routesFound: beforeRoutes.length,
      output: formatHuman(result)
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function main() {
  const repoPaths = process.argv.slice(2)

  if (repoPaths.length === 0) {
    console.error('Usage: ts-node test/smoke.ts <repo-path> [repo-path2] ...')
    process.exit(1)
  }

  console.log(`\nProdgate Smoke Test`)
  console.log(`${'─'.repeat(50)}`)
  console.log(`Testing ${repoPaths.length} repo(s)\n`)

  const results: TestResult[] = []

  for (const repoPath of repoPaths) {
    if (!fs.existsSync(repoPath)) {
      results.push({
        repo: repoPath,
        passed: false,
        reason: 'Path does not exist',
        routesFound: 0
      })
      continue
    }

    process.stdout.write(`Testing ${path.basename(repoPath)}... `)
    const result = await runSmokeTest(repoPath)
    results.push(result)
    console.log(result.passed ? 'PASS' : 'FAIL')
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results:\n`)

  for (const r of results) {
    const status = r.passed ? '[PASS]' : '[FAIL]'
    console.log(`${status} ${r.repo}`)
    console.log(`       Routes found: ${r.routesFound}`)
    console.log(`       ${r.reason}`)
    if (!r.passed && r.output) {
      console.log(`\n       Prodgate output:`)
      console.log(r.output.split('\n').map(l => `       ${l}`).join('\n'))
    }
    console.log()
  }

  const passed = results.filter(r => r.passed).length
  const total = results.length
  console.log(`${'─'.repeat(50)}`)
  console.log(`${passed}/${total} repos passed`)
  console.log()

  if (passed < total) process.exit(1)
}

main()