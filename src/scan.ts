/**
 * scan.ts
 *
 * Single-tree access-control reporter. Unlike `check` (a diff that only speaks
 * up when a PR removes a guard), `scan` reports the CURRENT auth posture of one
 * codebase, so a team gets an immediate, on-demand answer to "what's exposed
 * right now" without first introducing a regression.
 *
 * Each route is classified into one of three states using effective auth
 * (mount-level + route-level guards):
 *
 *   protected   - has a middleware recognised as auth.
 *   unprotected - has NO middleware, or only middleware known to be non-auth.
 *                 Split into mutations (CRITICAL) and reads (WARNING).
 *   uncertain   - has middleware we can't classify (e.g. a custom `checkUser`
 *                 guard or an inline function). We do NOT call these unprotected;
 *                 we surface them so the user can confirm. This keeps the
 *                 name-pattern blind spot honest instead of crying wolf.
 */

import { Route, RouterMount } from './extract'
import { effectiveMiddlewares, isAuthMiddleware, isMutationMethod } from './diff'

export type RouteState = 'protected' | 'unprotected' | 'uncertain'

export type ScannedRoute = {
  method: string
  path: string
  file: string
  line: number
  state: RouteState
  isMutation: boolean
  likelyPublic: boolean   // unprotected, but the path signals it is public by design
  auth: string[]          // recognised auth middleware (protected routes)
  unrecognized: string[]  // middleware we couldn't classify (uncertain routes)
}

export type ScanResult = {
  routes: ScannedRoute[]
  stats: {
    total: number
    protected: number
    unprotectedMutations: number  // concerning: excludes public-by-convention
    unprotectedReads: number      // concerning: excludes public-by-convention
    publicByConvention: number    // login/health/webhook-style routes, surfaced not alarmed
    uncertain: number
  }
}

// Paths that are public by design: flagging them as missing auth is cry-wolf
// (login can't require auth). Surfaced separately, kept out of the alarm count.
const PUBLIC_PATH = /(^|\/)(login|sign-?in|sign-?up|register|logout|sign-?out|forgot-?password|reset-?password|verify-?email|oauth|sso|callback|healthz?|health-?check|ping|readyz?|livez?|metrics|webhooks?|hooks?|docs|swagger|openapi|public|robots\.txt|favicon\.ico)(\/|$)/i

// Common Express middleware that is definitely not auth. A route whose only
// middleware is on this list is confidently "unprotected" rather than uncertain.
const KNOWN_NONAUTH = new Set([
  'cors', 'json', 'urlencoded', 'raw', 'text', 'static',
  'bodyparser', 'body-parser', 'express.json', 'express.urlencoded', 'express.static',
  'helmet', 'compression', 'morgan', 'logger', 'pino', 'pinohttp',
  'ratelimit', 'rate-limit', 'ratelimiter', 'expressratelimit', 'slowdown',
  'multer', 'upload', 'cookieparser', 'cookie-parser', 'csurf', 'csrf',
  'validate', 'validatebody', 'validaterequest', 'validation', 'expressvalidator',
  'asynchandler', 'catchasync', 'trycatch',
])

function normalize(name: string): string {
  return name.toLowerCase().replace(/\(\.\.\.\)$/, '').replace(/\(\)$/, '')
}

export function scanRoutes(routes: Route[], mounts: RouterMount[]): ScanResult {
  const scanned: ScannedRoute[] = []

  for (const route of routes) {
    // `use` entries are app/router-level middleware mounts, not endpoints.
    if (route.method === 'use') continue

    const eff = effectiveMiddlewares(route, mounts)
    const auth = eff.filter(isAuthMiddleware)
    const isMutation = isMutationMethod(route.method)

    let state: RouteState
    let unrecognized: string[] = []

    if (auth.length > 0) {
      state = 'protected'
    } else {
      // No recognised auth. Anything we can't vouch is non-auth keeps the route
      // out of "unprotected" and into "uncertain".
      unrecognized = eff.filter(m => !KNOWN_NONAUTH.has(normalize(m)))
      state = unrecognized.length === 0 ? 'unprotected' : 'uncertain'
    }

    const likelyPublic = state === 'unprotected' && PUBLIC_PATH.test(route.path)

    scanned.push({
      method: route.method,
      path: route.path,
      file: route.file,
      line: route.line,
      state,
      isMutation,
      likelyPublic,
      auth,
      unrecognized,
    })
  }

  const concerning = (r: ScannedRoute) => r.state === 'unprotected' && !r.likelyPublic

  const stats = {
    total: scanned.length,
    protected: scanned.filter(r => r.state === 'protected').length,
    unprotectedMutations: scanned.filter(r => concerning(r) && r.isMutation).length,
    unprotectedReads: scanned.filter(r => concerning(r) && !r.isMutation).length,
    publicByConvention: scanned.filter(r => r.state === 'unprotected' && r.likelyPublic).length,
    uncertain: scanned.filter(r => r.state === 'uncertain').length,
  }

  return { routes: scanned, stats }
}
