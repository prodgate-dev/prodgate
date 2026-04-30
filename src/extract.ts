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
import { RouterMount } from './diff'

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

export function extractRouterMounts(code: string, filePath: string): RouterMount[] {
  const mounts: RouterMount[] = []
  let ast: any

  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript']
    })
  } catch (e) {
    return mounts
  }

  traverse(ast, {
    CallExpression(nodePath) {
      const callee = nodePath.node.callee
      if (callee.type !== 'MemberExpression') return
      if (callee.property.type !== 'Identifier') return
      if (callee.property.name !== 'use') return

      const args = nodePath.node.arguments
      if (args.length < 2) return

      // First arg must be a path string
      if (args[0].type !== 'StringLiteral') return

      const mountPath = (args[0] as any).value

      // Last arg should be a router/handler identifier
      const last = args[args.length - 1] as any
      if (last.type !== 'Identifier') return

      const routerName = last.name

      // Middle args are middleware
      const middlewares = args.slice(1, -1).flatMap((arg: any) => {
        if (arg.type === 'ArrayExpression') {
          return arg.elements.map(extractMiddlewareName)
        }
        return extractMiddlewareName(arg)
      })

      // Only care about mounts that have middleware — these are the ones
      // that can regress
      if (middlewares.length === 0) return

      mounts.push({
        file: filePath,
        path: mountPath,
        middlewares,
        routerName
      })
    }
  })

  return mounts
}

export function isLikelyRouteFile(code: string): boolean {
  const hasRouterPattern = /\.(get|post|put|delete|patch|use)\s*\(/.test(code)
  const hasExpressImport = /require\s*\(\s*['"]express['"]|from\s*['"]express['"]/.test(code)
  const hasRouterVar = /Router\(\)|express\.Router/.test(code)
  const hasTestPatterns = /describe\s*\(|it\s*\(|test\s*\(|supertest|jest\./.test(code)
  return hasRouterPattern && (hasExpressImport || hasRouterVar) && !hasTestPatterns
}

export async function scanRepo(repoPath: string): Promise<{
  routes: Route[]
  mounts: RouterMount[]
}> {
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
  const allMounts: RouterMount[] = []

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8')
    if (!isLikelyRouteFile(code)) continue
    const routes = extractRoutes(code, file)
    const mounts = extractRouterMounts(code, file)
    if (routes.length > 0) allRoutes.push(...routes)
    if (mounts.length > 0) allMounts.push(...mounts)
  }

  return { routes: allRoutes, mounts: allMounts }
}