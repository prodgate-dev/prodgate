/**
 * extract.ts
 *
 * AST-based route extractor for Express applications.
 *
 * Parses JavaScript and TypeScript source files using @babel/parser,
 * walks the AST to find Express route definitions (router.get, router.post, etc.),
 * and extracts the HTTP method, path, middleware chain, handler, and line number
 * for each route.
 *
 * Auto-detects route files by checking for Express import patterns and router
 * variable usage. Supports a prodgate.config.json escape hatch for explicit
 * directory configuration, auth pattern overrides, and ignore paths.
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
  line: number
}

export type RouterMount = {
  file: string
  path: string
  middlewares: string[]
  routerName: string
  line: number
}

export type ProdgateConfig = {
  routesDir?: string
  authPatterns?: string[]
  ignore?: string[]
  strict?: boolean
}

export function loadConfig(repoPath: string): ProdgateConfig {
  const configPath = path.join(repoPath, 'prodgate.config.json')
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) {
    return {}
  }
}

const extractMiddlewareName = (arg: any): string => {
  if (arg.type === 'Identifier') return arg.name
  if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') {
    return `${arg.callee.name}(...)`
  }
  if (arg.type === 'MemberExpression' &&
    arg.object.type === 'Identifier' &&
    arg.property.type === 'Identifier') {
    return `${arg.object.name}.${arg.property.name}`
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
      const line = nodePath.node.loc?.start.line ?? 0

      // Skip router mounts — handled by extractRouterMounts
      if (method === 'use' && last?.type === 'Identifier' && 
          /[Rr]outer$/.test(last.name)) return

      routes.push({ file: filePath, method, path: routePath, middlewares, handler, line })
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
      if (args[0].type !== 'StringLiteral') return

      const mountPath = (args[0] as any).value
      const last = args[args.length - 1] as any
      if (last.type !== 'Identifier') return

      const routerName = last.name

      const middlewares = args.slice(1, -1).flatMap((arg: any) => {
        if (arg.type === 'ArrayExpression') {
          return arg.elements.map(extractMiddlewareName)
        }
        return extractMiddlewareName(arg)
      })

      const line = nodePath.node.loc?.start.line ?? 0

      mounts.push({ file: filePath, path: mountPath, middlewares, routerName, line })
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

/**
 * Resolves the full mounted path for each route by matching routes to their
 * router mount points.
 *
 * This is a heuristic based on naming conventions — adminRouter is expected
 * to be defined in a file containing "admin" in the path. This covers the
 * vast majority of real Express codebases but will miss unusual naming.
 *
 * For repos where this heuristic gets it wrong, users can specify routesDir
 * in prodgate.config.json to scope extraction explicitly.
 */
export function resolveFullPaths(
  routes: Route[],
  mounts: RouterMount[]
): Route[] {
  return routes.map(route => {
    const normalizedFile = route.file.replace(/\\/g, '/')
    // Only match against the filename, not the full path
    // This prevents false matches on directory names like C:/Users/...
    const filename = normalizedFile.split('/').pop()?.toLowerCase() ?? ''

    const mount = mounts.find(m => {
      const routerName = m.routerName.toLowerCase()
      const baseName = routerName.replace(/router$/i, '')
      return filename.includes(baseName) || filename.includes(routerName)
    })

    if (!mount) return route

    const mountPath = mount.path.replace(/\/$/, '')
    const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`
    const fullPath = `${mountPath}${routePath}`

    return { ...route, path: fullPath }
  })
}

export async function scanRepo(repoPath: string): Promise<{
  routes: Route[]
  mounts: RouterMount[]
  config: ProdgateConfig
}> {
  const normalizedPath = repoPath.replace(/\\/g, '/')
  const config = loadConfig(repoPath)

  let globPattern = `${normalizedPath}/**/*.{js,ts}`
  if (config.routesDir) {
    globPattern = `${normalizedPath}/${config.routesDir}/**/*.{js,ts}`
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

  
  const resolvedRoutes = resolveFullPaths(allRoutes, allMounts)
  
  return { routes: resolvedRoutes, mounts: allMounts, config }
}