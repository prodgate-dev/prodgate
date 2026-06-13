/**
 * Compares two route snapshots and produces a structured diff result.
 *
 * Detects access control regressions across six categories:
 *   - Route lost auth middleware (CRITICAL)
 *   - Auth middleware order changed (CRITICAL)
 *   - New unprotected mutation route (CRITICAL)
 *   - Router-level auth removed (CRITICAL)
 *   - Shadowed route — unprotected handler runs before protected one (WARNING)
 *   - Inconsistent sibling protection (WARNING)
 *
 * Returns a DiffResult with route-centric Finding entries and a deterministic
 * pass/fail verdict. CRITICAL issues always fail CI. WARNING issues fail CI
 * only when --strict is passed.
 */

import { Route, RouterMount } from './extract'

export type DeltaType =
  | 'protected_to_unprotected'
  | 'privilege_weakened'
  | 'order_changed'
  | 'new_unprotected_route'
  | 'inconsistent_with_siblings'
  | 'shadowed_route'
  | 'router_auth_removed'

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export type Finding = {
  severity: Severity
  deltaType: DeltaType
  route: {
    method: string
    path: string
    file: string
    line: number
  }
  auth: {
    beforeEffective: string[]
    afterEffective: string[]
    removed: string[]
    added: string[]
    orderChanged: boolean
  }
  message: string
  rootCause?: {
    type: 'router_middleware_removed' | 'route_middleware_removed' | 'route_order_conflict'
    scope: string
  }
  affectedRoutes?: string[]
  siblingContext?: {
    path: string
    method: string
    middlewares: string[]
  }[]
}

export type DiffResult = {
  findings: Finding[]
  verdict: 'pass' | 'fail'
  stats: {
    routesScanned: number
    criticalCount: number
    warningCount: number
    infoCount: number
  }
}

//HELPERS

export function canonicalizeMiddleware(name: string): string {
  // Strip trailing () from call expressions
  const stripped = name.replace(/\(\.\.\.\)$/, '').replace(/\(\)$/, '')
  // Handle unknown/anonymous
  if (stripped === 'unknown') return '<anonymous>'
  return stripped
}

export function isAuthMiddleware(name: string): boolean {
  return /auth|require|guard|protect|verify|session|jwt|token|permission|role|super/i.test(name)
}

function isMutationMethod(method: string): boolean {
  return ['post', 'put', 'delete', 'patch'].includes(method.toLowerCase())
}

function computeSeverity(deltaType: DeltaType, method: string): Severity {
  if (deltaType === 'protected_to_unprotected') return 'CRITICAL'
  if (deltaType === 'router_auth_removed') return 'CRITICAL'
  if (deltaType === 'order_changed') return 'CRITICAL'
  if (deltaType === 'privilege_weakened' && isMutationMethod(method)) return 'CRITICAL'
  if (deltaType === 'new_unprotected_route' && isMutationMethod(method)) return 'CRITICAL'
  if (deltaType === 'shadowed_route') return 'CRITICAL'
  if (deltaType === 'inconsistent_with_siblings') return 'WARNING'
  if (deltaType === 'new_unprotected_route') return 'WARNING'
  if (deltaType === 'privilege_weakened') return 'WARNING'
  return 'INFO'
}

export function routeKey(r: Route): string {
  const normalized = r.file.replace(/\\/g, '/')
  const match = normalized.match(/\/(src|api|routes|controllers|handlers)\/.+/)
  const relative = match ? match[0] : normalized.split('/').pop() ?? normalized
  return `${r.method}:${r.path}:${relative}`
}

function effectiveMiddlewares(
  route: Route,
  mounts: RouterMount[]
): string[] {
  const routerMw = mounts
    .filter(m => route.path.startsWith(m.path) || route.file.includes(m.routerName))
    .flatMap(m => m.middlewares)
    .map(canonicalizeMiddleware)

  const routeMw = route.middlewares.map(canonicalizeMiddleware)
  return [...new Set([...routerMw, ...routeMw])]
}

function orderChanged(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false
  const sameElements = before.every(m => after.includes(m)) &&
    after.every(m => before.includes(m))
  if (!sameElements) return false
  return before.some((m, i) => m !== after[i])
}

//Detection Functions

function detectRouteChanges(
  before: Route[],
  after: Route[],
  beforeMounts: RouterMount[],
  afterMounts: RouterMount[],
  ignorePaths: string[]
): Finding[] {
  const findings: Finding[] = []
  const beforeMap = new Map(before.map(r => [routeKey(r), r]))
  const afterMap = new Map(after.map(r => [routeKey(r), r]))

  for (const [key, beforeRoute] of beforeMap) {
    if (ignorePaths.some(p => beforeRoute.path.startsWith(p))) continue

    const afterRoute = afterMap.get(key)
    if (!afterRoute) continue

    // Use route-level middleware only for detecting route-level regressions
    // Router-level auth removal is handled separately by detectRouterAuthRemoval
    const beforeEff = beforeRoute.middlewares.map(canonicalizeMiddleware)
    const afterEff = afterRoute.middlewares.map(canonicalizeMiddleware)

    const removed = beforeEff.filter(m => !afterEff.includes(m))
    const added = afterEff.filter(m => !beforeEff.includes(m))
    const changed = orderChanged(
      beforeRoute.middlewares.map(canonicalizeMiddleware),
      afterRoute.middlewares.map(canonicalizeMiddleware)
    )

    if (removed.length === 0 && added.length === 0 && !changed) continue

    const hadAuth = beforeEff.some(isAuthMiddleware)
    const hasAuth = afterEff.some(isAuthMiddleware)
    const lostAuth = hadAuth && !hasAuth
    const weakened = hadAuth && hasAuth && removed.some(isAuthMiddleware)

    let deltaType: DeltaType
    if (lostAuth) {
      deltaType = 'protected_to_unprotected'
    } else if (changed && removed.some(isAuthMiddleware)) {
      deltaType = 'order_changed'
    } else if (weakened) {
      deltaType = 'privilege_weakened'
    } else {
      continue
    }

    const severity = computeSeverity(deltaType, afterRoute.method)

    findings.push({
      severity,
      deltaType,
      route: {
        method: afterRoute.method,
        path: afterRoute.path,
        file: afterRoute.file,
        line: afterRoute.line
      },
      auth: {
        beforeEffective: beforeEff,
        afterEffective: afterEff,
        removed,
        added,
        orderChanged: changed
      },
      message: `Access control regression: ${afterRoute.method.toUpperCase()} ${afterRoute.path}`,
      rootCause: {
        type: 'route_middleware_removed',
        scope: afterRoute.path
      }
    })
  }

  return findings
}

function detectNewUnprotectedRoutes(
  before: Route[],
  after: Route[],
  afterMounts: RouterMount[],
  ignorePaths: string[]
): Finding[] {
  const findings: Finding[] = []
  const beforeMap = new Map(before.map(r => [routeKey(r), r]))

  for (const afterRoute of after) {
    if (beforeMap.has(routeKey(afterRoute))) continue
    if (afterRoute.method === 'use') continue
    if (ignorePaths.some(p => afterRoute.path.startsWith(p))) continue

    const afterEff = effectiveMiddlewares(afterRoute, afterMounts)
    const hasAuth = afterEff.some(isAuthMiddleware)
    if (hasAuth) continue

    const severity = computeSeverity('new_unprotected_route', afterRoute.method)

    findings.push({
      severity,
      deltaType: 'new_unprotected_route',
      route: {
        method: afterRoute.method,
        path: afterRoute.path,
        file: afterRoute.file,
        line: afterRoute.line
      },
      auth: {
        beforeEffective: [],
        afterEffective: afterEff,
        removed: [],
        added: afterEff,
        orderChanged: false
      },
      message: `New unprotected route: ${afterRoute.method.toUpperCase()} ${afterRoute.path}`
    })
  }

  return findings
}

function detectRouterAuthRemoval(
  beforeMounts: RouterMount[],
  afterMounts: RouterMount[],
  afterRoutes: Route[],
  ignorePaths: string[]
): Finding[] {
  const findings: Finding[] = []

  const mountKey = (m: RouterMount) => {
    const normalized = m.file.replace(/\\/g, '/')
    const filename = normalized.split('/').pop() ?? normalized
    return `${m.path}:${filename}`
  }

  const beforeMap = new Map(beforeMounts.map(m => [mountKey(m), m]))
  const afterMap = new Map(afterMounts.map(m => [mountKey(m), m]))

  for (const [key, beforeMount] of beforeMap) {
    if (ignorePaths.some(p => beforeMount.path.startsWith(p))) continue

    const afterMount = afterMap.get(key)
    if (!afterMount) continue

    const bm = beforeMount.middlewares.map(canonicalizeMiddleware)
    const am = afterMount.middlewares.map(canonicalizeMiddleware)

    const removed = bm.filter(m => !am.includes(m))
    if (removed.length === 0) continue

    const lostAuth = removed.some(isAuthMiddleware)
    if (!lostAuth) continue

    const affected = afterRoutes
      .filter(r => r.path.startsWith(afterMount.path) || r.file.includes(afterMount.routerName))
      .map(r => `${r.method.toUpperCase()} ${r.path}`)

    findings.push({
      severity: 'CRITICAL',
      deltaType: 'router_auth_removed',
      route: {
        method: 'use',
        path: afterMount.path,
        file: afterMount.file,
        line: 0
      },
      auth: {
        beforeEffective: bm,
        afterEffective: am,
        removed,
        added: [],
        orderChanged: false
      },
      message: `Access control regression: Router ${afterMount.path} lost auth middleware`,
      rootCause: {
        type: 'router_middleware_removed',
        scope: afterMount.path
      },
      affectedRoutes: affected
    })
  }

  return findings
}

function detectShadowedRoutes(
  after: Route[],
  ignorePaths: string[]
): Finding[] {
  const findings: Finding[] = []
  const routesByMethodPath = new Map<string, Route[]>()

  for (const r of after) {
    if (ignorePaths.some(p => r.path.startsWith(p))) continue
    const key = `${r.method}:${r.path}`
    const existing = routesByMethodPath.get(key) ?? []
    routesByMethodPath.set(key, [...existing, r])
  }

  for (const [, routes] of routesByMethodPath) {
    if (routes.length < 2) continue
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const earlier = routes[i]
        const later = routes[j]
        const earlierHasAuth = earlier.middlewares.some(isAuthMiddleware)
        const laterHasAuth = later.middlewares.some(isAuthMiddleware)

        if (!earlierHasAuth && laterHasAuth) {
          findings.push({
            severity: 'CRITICAL',
            deltaType: 'shadowed_route',
            route: {
              method: earlier.method,
              path: earlier.path,
              file: earlier.file,
              line: earlier.line
            },
            auth: {
              beforeEffective: [],
              afterEffective: earlier.middlewares.map(canonicalizeMiddleware),
              removed: [],
              added: [],
              orderChanged: false
            },
            message: `Route reachability conflict: ${earlier.method.toUpperCase()} ${earlier.path} is unprotected and Express will match it before the protected handler`
          })
        }
      }
    }
  }

  return findings
}

function detectInconsistentSiblings(
  after: Route[],
  findings: Finding[],
  ignorePaths: string[]
): Finding[] {
  const newFindings: Finding[] = []
  const routesByBase = new Map<string, Route[]>()

  for (const r of after) {
    if (ignorePaths.some(p => r.path.startsWith(p))) continue
    const basePath = r.path.replace(/\/:[^/]+/g, '/:param')
    const existing = routesByBase.get(basePath) ?? []
    routesByBase.set(basePath, [...existing, r])
  }

  for (const [basePath, routes] of routesByBase) {
    if (routes.length < 2) continue
    const withAuth = routes.filter(r => r.middlewares.some(isAuthMiddleware))
    const withoutAuth = routes.filter(r => !r.middlewares.some(isAuthMiddleware))
    if (withAuth.length === 0 || withoutAuth.length === 0) continue

    for (const r of withoutAuth) {
      const alreadyFlagged = findings.some(f =>
        f.route.path === r.path &&
        f.route.method === r.method &&
        f.severity === 'CRITICAL'
      )
      if (alreadyFlagged) continue

      newFindings.push({
        severity: 'WARNING',
        deltaType: 'inconsistent_with_siblings',
        route: {
          method: r.method,
          path: r.path,
          file: r.file,
          line: r.line
        },
        auth: {
          beforeEffective: [],
          afterEffective: r.middlewares.map(canonicalizeMiddleware),
          removed: [],
          added: [],
          orderChanged: false
        },
        message: `${r.method.toUpperCase()} ${r.path} is unprotected while sibling routes require auth`,
        siblingContext: withAuth.map(s => ({
          path: s.path,
          method: s.method,
          middlewares: s.middlewares.map(canonicalizeMiddleware)
        }))
      })
    }
  }

  return newFindings
}

// ─── Main Diff Function ────────────────────────────────────────────────────────

export function diffRoutes(
  before: Route[],
  after: Route[],
  beforeMounts: RouterMount[] = [],
  afterMounts: RouterMount[] = [],
  ignorePaths: string[] = []
): DiffResult {
  const findings: Finding[] = []

  // Router-level auth removal first — needed for dedup
  const routerFindings = detectRouterAuthRemoval(beforeMounts, afterMounts, after, ignorePaths)
  findings.push(...routerFindings)

  // Route-level changes
  const routeFindings = detectRouteChanges(before, after, beforeMounts, afterMounts, ignorePaths)

  // Deduplicate: skip route-level findings already covered by a router-level finding
  for (const f of routeFindings) {
    const coveredByRouter = routerFindings.some(rf =>
      rf.affectedRoutes?.some(ar =>
        ar === `${f.route.method.toUpperCase()} ${f.route.path}`
      )
    )
    if (!coveredByRouter) findings.push(f)
  }

  // Shadowed routes
  const shadowFindings = detectShadowedRoutes(after, ignorePaths)
  findings.push(...shadowFindings)

  // Inconsistent siblings — must come after shadow so dedup works
  const siblingFindings = detectInconsistentSiblings(after, findings, ignorePaths)
  findings.push(...siblingFindings)

  // New unprotected routes
  const newRouteFindings = detectNewUnprotectedRoutes(before, after, afterMounts, ignorePaths)
  findings.push(...newRouteFindings)

  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length
  const warningCount = findings.filter(f => f.severity === 'WARNING').length
  const infoCount = findings.filter(f => f.severity === 'INFO').length
  const verdict = criticalCount > 0 ? 'fail' : 'pass'

  return {
    findings,
    verdict,
    stats: {
      routesScanned: after.length,
      criticalCount,
      warningCount,
      infoCount
    }
  }
}