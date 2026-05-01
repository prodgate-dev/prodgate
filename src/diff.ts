/**
 * Compares two route snapshots and produces a structured diff result.
 *
 * Detects four categories of access control regression:
 *   - Middleware removed from an existing route (CRITICAL)
 *   - Auth middleware order changed on an existing route (CRITICAL)
 *   - New route added with no middleware (CRITICAL for mutation methods, WARNING for GET)
 *   - Inconsistent protection across sibling routes on the same path (WARNING)
 *
 * Returns a DiffResult with severity-tagged entries and a deterministic
 * pass/fail verdict. CRITICAL issues fail CI. WARNING issues fail CI only
 * when --strict is passed.
 */


import { Route } from './extract'

export type RouterMount = {
  file: string
  path: string
  middlewares: string[]
  routerName: string
}

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export type DiffEntry = {
  severity: Severity
  type: 'middleware_removed' | 'middleware_reordered' | 'unprotected_new_route' | 'inconsistent_protection' | 'middleware_added' | 'route_removed'
  route: Route
  before?: string[]
  after?: string[]
  message: string
}

export type DiffResult = {
  entries: DiffEntry[]
  verdict: 'pass' | 'fail'
  stats: {
    routesScanned: number
    criticalCount: number
    warningCount: number
    infoCount: number
  }
}

const SENSITIVE_METHODS = ['post', 'put', 'delete', 'patch']

export function routeKey(r: Route): string {
  const normalized = r.file.replace(/\\/g, '/')
  const filename = normalized.split('/').pop() ?? normalized
  return `${r.method}:${r.path}:${filename}`
}

function authLost(before: string[], after: string[]): boolean {
  const lost = before.filter(m => !after.includes(m))
  return lost.length > 0 && before.length > after.length
}

function orderChanged(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false
  const sameElements = before.every(m => after.includes(m))
  if (!sameElements) return false
  return before.some((m, i) => m !== after[i])
}

function isAuthMiddleware(name: string): boolean {
  return /auth|require|guard|protect|verify|session|jwt|token|permission|role|super/i.test(name)
}

export function diffRoutes(before: Route[],after: Route[],beforeMounts: RouterMount[] = [],
                            afterMounts: RouterMount[] = []):
                             DiffResult {

  const beforeMap = new Map(before.map(r => [routeKey(r), r]))
  const afterMap = new Map(after.map(r => [routeKey(r), r]))

  const entries: DiffEntry[] = []

  // Check changed and removed routes
  for (const [key, beforeRoute] of beforeMap) {
    const afterRoute = afterMap.get(key)

    if (!afterRoute) {
      entries.push({
        severity: 'INFO',
        type: 'route_removed',
        route: beforeRoute,
        message: `Route removed: ${beforeRoute.method.toUpperCase()} ${beforeRoute.path}`
      })
      continue
    }

    const bm = beforeRoute.middlewares
    const am = afterRoute.middlewares

    const same = bm.length === am.length && bm.every((m, i) => m === am[i])
    if (same) continue


    if (authLost(bm, am)) {
      const lost = bm.filter(m => !am.includes(m))
      entries.push({
        severity: 'CRITICAL',
        type: 'middleware_removed',
        route: afterRoute,
        before: bm,
        after: am,
        message: `${afterRoute.method.toUpperCase()} ${afterRoute.path} lost auth middleware: ${lost.join(', ')}`
      })
    } else if (orderChanged(bm, am)) {
      const hasAuthInvolved = [...bm, ...am].some(isAuthMiddleware)
      entries.push({
        severity: hasAuthInvolved ? 'CRITICAL' : 'WARNING',
        type: 'middleware_reordered',
        route: afterRoute,
        before: bm,
        after: am,
        message: `${afterRoute.method.toUpperCase()} ${afterRoute.path} middleware order changed`
      })
    } else if (am.length > bm.length) {
      entries.push({
        severity: 'INFO',
        type: 'middleware_added',
        route: afterRoute,
        before: bm,
        after: am,
        message: `${afterRoute.method.toUpperCase()} ${afterRoute.path} gained middleware`
      })
    }
  }

  // Check new routes
  for (const [key, afterRoute] of afterMap) {
    if (beforeMap.has(key)) continue

    if (afterRoute.middlewares.length === 0 && afterRoute.method !== 'use') {
      const severity = SENSITIVE_METHODS.includes(afterRoute.method) ? 'CRITICAL' : 'WARNING'
      entries.push({
        severity,
        type: 'unprotected_new_route',
        route: afterRoute,
        message: `New unprotected route: ${afterRoute.method.toUpperCase()} ${afterRoute.path}`
      })
    } else if (afterRoute.middlewares.length > 0) {
      entries.push({
        severity: 'INFO',
        type: 'middleware_added',
        route: afterRoute,
        message: `New protected route: ${afterRoute.method.toUpperCase()} ${afterRoute.path}`
      })
    }
  }

  const shadowEntries = detectShadowedRoutes(after)
  entries.push(...shadowEntries)
  
  // Check inconsistent protection across sibling routes
  const routesByPath = new Map<string, Route[]>()
  for (const r of after) {
    const basePath = r.path.replace(/\/:[^/]+/g, '/:param')
    const existing = routesByPath.get(basePath) ?? []
    routesByPath.set(basePath, [...existing, r])
  }

  for (const [basePath, routes] of routesByPath) {
    if (routes.length < 2) continue
    const withAuth = routes.filter(r => r.middlewares.some(isAuthMiddleware))
    const withoutAuth = routes.filter(r => !r.middlewares.some(isAuthMiddleware))
    if (withAuth.length > 0 && withoutAuth.length > 0) {
      for (const r of withoutAuth) {
  const alreadyFlagged = entries.some(e => 
    e.route.path === r.path && 
    e.route.method === r.method &&
    e.severity === 'CRITICAL'
  )
  if (alreadyFlagged) continue
  entries.push({
    severity: 'WARNING',
    type: 'inconsistent_protection',
    route: r,
    message: `${r.method.toUpperCase()} ${r.path} is unprotected while sibling routes on ${basePath} require auth`
  })
}
    }
  }

  // Check router mount regressions
  const mountEntries = diffRouterMounts(beforeMounts, afterMounts)
  entries.push(...mountEntries)

  const criticalCount = entries.filter(e => e.severity === 'CRITICAL').length
  const warningCount = entries.filter(e => e.severity === 'WARNING').length
  const infoCount = entries.filter(e => e.severity === 'INFO').length

  const verdict = criticalCount > 0 ? 'fail' : 'pass'

  return {
    entries,
    verdict,
    stats: {
      routesScanned: after.length,
      criticalCount,
      warningCount,
      infoCount
    }
  }
}

export function diffRouterMounts(
  before: RouterMount[],
  after: RouterMount[]
): DiffEntry[] {
  const entries: DiffEntry[] = []

  const mountKey = (m: RouterMount) => {
    const normalized = m.file.replace(/\\/g, '/')
    const filename = normalized.split('/').pop() ?? normalized
    return `${m.path}:${filename}`
  }

  const beforeMap = new Map(before.map(m => [mountKey(m), m]))
  const afterMap = new Map(after.map(m => [mountKey(m), m]))

  for (const [key, beforeMount] of beforeMap) {
    const afterMount = afterMap.get(key)
    if (!afterMount) continue

    const bm = beforeMount.middlewares
    const am = afterMount.middlewares

    const same = bm.length === am.length && bm.every((m, i) => m === am[i])
    if (same) continue

    if (bm.length > am.length) {
      const lost = bm.filter(m => !am.includes(m))
      const hasAuthLost = lost.some(isAuthMiddleware)

      entries.push({
        severity: hasAuthLost ? 'CRITICAL' : 'WARNING',
        type: 'middleware_removed',
        route: {
          file: beforeMount.file,
          method: 'use',
          path: beforeMount.path,
          middlewares: am,
          handler: beforeMount.routerName
        },
        before: bm,
        after: am,
        message: `Router mount ${beforeMount.path} lost middleware: ${lost.join(', ')} — all routes under ${beforeMount.path} may now be unprotected`
      })
    }
  }

  return entries
}

function detectShadowedRoutes(after: Route[]): DiffEntry[] {
  const entries: DiffEntry[] = []

  // Group routes by method + normalized path
  const routesByMethodPath = new Map<string, Route[]>()

  for (const r of after) {
    const key = `${r.method}:${r.path}`
    const existing = routesByMethodPath.get(key) ?? []
    routesByMethodPath.set(key, [...existing, r])
  }

  for (const [, routes] of routesByMethodPath) {
    if (routes.length < 2) continue

    // Check if any unprotected route appears before a protected one
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const earlier = routes[i]
        const later = routes[j]

        const earlierHasAuth = earlier.middlewares.some(isAuthMiddleware)
        const laterHasAuth = later.middlewares.some(isAuthMiddleware)

        if (!earlierHasAuth && laterHasAuth) {
          entries.push({
            severity: 'CRITICAL',
            type: 'middleware_removed',
            route: earlier,
            message: `${earlier.method.toUpperCase()} ${earlier.path} is unprotected and shadows a protected route of the same path — Express will serve the unprotected handler first`
          })
        }
      }
    }
  }

  return entries
}