/**
 * Compares two route snapshots and produces a structured diff result.
 *
 * Detects access control regressions across these categories:
 *   - Route lost auth middleware (CRITICAL)
 *   - Privilege weakened on a mutation route (CRITICAL)
 *   - New unprotected mutation route (CRITICAL)
 *   - Router-level auth removed (CRITICAL)
 *   - Shadowed route: unprotected handler matches before the protected one (CRITICAL)
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
  // routes have full paths via resolveFullPaths,
  // mounts can be matched by path prefix rather than filename heuristic
  const routerMw = mounts
    .filter(m => route.path.startsWith(m.path))
    .flatMap(m => m.middlewares)
    .map(canonicalizeMiddleware)

  const routeMw = route.middlewares.map(canonicalizeMiddleware)
  return [...new Set([...routerMw, ...routeMw])]
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

    // Compute effective auth: combines mount-level and route-level middleware
    const beforeEff = effectiveMiddlewares(beforeRoute, beforeMounts)
    const afterEff = effectiveMiddlewares(afterRoute, afterMounts)

    // Compute route-local changes for display
    const beforeLocal = beforeRoute.middlewares.map(canonicalizeMiddleware)
    const afterLocal = afterRoute.middlewares.map(canonicalizeMiddleware)

    const removed = beforeEff.filter(m => !afterEff.includes(m))
    const added = afterEff.filter(m => !beforeEff.includes(m))

    // If effective auth didn't change, no finding needed
    if (removed.length === 0 && added.length === 0) continue

    const hadAuth = beforeEff.some(isAuthMiddleware)
    const hasAuth = afterEff.some(isAuthMiddleware)
    const lostAuth = hadAuth && !hasAuth
    const weakened = hadAuth && hasAuth && removed.some(isAuthMiddleware)

    // Route-local middleware changed but mount-level auth still fully protects
    // the route, so suppress; this is not a regression
    const localChanged = beforeLocal.join(',') !== afterLocal.join(',')
    const effectivelyUnchanged = removed.length === 0 && added.length === 0
    if (localChanged && effectivelyUnchanged) continue

    let deltaType: DeltaType
    if (lostAuth) {
      deltaType = 'protected_to_unprotected'
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
        orderChanged: false
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
  mounts: RouterMount[],
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
        // Use effective auth (mount + route level) so a route protected only
        // by its router mount is not mistaken for unprotected.
        const earlierHasAuth = effectiveMiddlewares(earlier, mounts).some(isAuthMiddleware)
        const laterHasAuth = effectiveMiddlewares(later, mounts).some(isAuthMiddleware)

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
              afterEffective: effectiveMiddlewares(earlier, mounts),
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
  mounts: RouterMount[],
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
    // Compare effective auth, not route-local middleware: a route protected by
    // its router mount is protected even with no route-level guard.
    const hasEffectiveAuth = (r: Route) =>
      effectiveMiddlewares(r, mounts).some(isAuthMiddleware)
    const withAuth = routes.filter(hasEffectiveAuth)
    const withoutAuth = routes.filter(r => !hasEffectiveAuth(r))
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
          afterEffective: effectiveMiddlewares(r, mounts),
          removed: [],
          added: [],
          orderChanged: false
        },
        message: `${r.method.toUpperCase()} ${r.path} is unprotected while sibling routes require auth`,
        siblingContext: withAuth.map(s => ({
          path: s.path,
          method: s.method,
          middlewares: effectiveMiddlewares(s, mounts)
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

  // Router-level auth removal first, needed for dedup
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
  const shadowFindings = detectShadowedRoutes(after, afterMounts, ignorePaths)
  findings.push(...shadowFindings)

  // Inconsistent siblings: must come after shadow so dedup works
  const siblingFindings = detectInconsistentSiblings(after, afterMounts, findings, ignorePaths)
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