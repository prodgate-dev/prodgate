/**
 * extract.ts
 *
 * AST-based route extractor for Express applications.
 *
 * Parses JavaScript and TypeScript source files using @babel/parser,
 * walks the AST to find Express route definitions (router.get, router.post, etc.),
 * and extracts the HTTP method, path, middleware chain, and handler for each route.
 *
 * Auto-detects route files by checking for Express import patterns and router
 * variable usage. Supports a prodgate.config.json escape hatch for explicit
 * directory configuration.
 */

import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import * as fs from 'fs'
import { glob } from 'glob'
import * as path from 'path'

export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'use']

export type Route = {
  file: string
  method: string
  path: string
  middlewares: string[]
  handler: string
}

const extractMiddlewareName = (arg: any): string => {
  if (arg.type === 'Identifier') return arg.name
  if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') {
    return `${arg.callee.name}(...)`
  }
  return 'unknown'
}

export function extractRoutes(code: string, filePath: string): Route[] {
  const routes: Route[] = []
  let ast: any

  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript']
    })
  } catch (e) {
    return routes
  }

  traverse(ast, {
    CallExpression(nodePath) {
      const callee = nodePath.node.callee
      if (callee.type !== 'MemberExpression') return
      if (callee.property.type !== 'Identifier') return
      if (!HTTP_METHODS.includes(callee.property.name)) return

      const method = callee.property.name
      const args = nodePath.node.arguments
      const routePath = args[0]?.type === 'StringLiteral'
        ? (args[0] as any).value
        : '?'

      if (routePath === '?') return

      const middlewares = args.slice(1, -1).flatMap((arg: any) => {
        if (arg.type === 'ArrayExpression') {
          return arg.elements.map(extractMiddlewareName)
        }
        return extractMiddlewareName(arg)
      })

      const last = args[args.length - 1] as any
      const handler = last?.type === 'Identifier' ? last.name : 'unknown'

      routes.push({ file: filePath, method, path: routePath, middlewares, handler })
    }
  })

  return routes
}

export function isLikelyRouteFile(code: string): boolean {
  const hasRouterPattern = /\.(get|post|put|delete|patch|use)\s*\(/.test(code)
  const hasExpressImport = /require\s*\(\s*['"]express['"]|from\s*['"]express['"]/.test(code)
  const hasRouterVar = /Router\(\)|express\.Router/.test(code)
  const hasTestPatterns = /describe\s*\(|it\s*\(|test\s*\(|supertest|jest\./.test(code)
  return hasRouterPattern && (hasExpressImport || hasRouterVar) && !hasTestPatterns
}

export async function scanRepo(repoPath: string): Promise<Route[]> {
  const normalizedPath = repoPath.replace(/\\/g, '/')
  const configPath = path.join(repoPath, 'prodgate.config.json')
  let globPattern = `${normalizedPath}/**/*.{js,ts}`

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (config.routesDir) {
        globPattern = `${normalizedPath}/${config.routesDir}/**/*.{js,ts}`
      }
    } catch (e) {
      // malformed config, fall back to auto-detection
    }
  }

  const files = await glob(globPattern, {
    ignore: [
      '**/node_modules/**',
      '**/*.test.{js,ts}',
      '**/*.spec.{js,ts}',
      '**/__tests__/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/frontend/**',
      '**/client/**',
      '**/public/**'
    ]
  })

  const allRoutes: Route[] = []

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8')
    if (!isLikelyRouteFile(code)) continue
    const routes = extractRoutes(code, file)
    if (routes.length > 0) allRoutes.push(...routes)
  }

  return allRoutes
}