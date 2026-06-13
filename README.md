# Prodgate

Access control regression detection for Express APIs.

Prodgate diffs the middleware chain of your Express backend across two versions of a codebase and produces a deterministic pass/fail verdict.

## Installation

```bash
npm install -g prodgate
```

## Usage

```bash
prodgate check --before <path> --after <path>
```

### Example output

```
Prodgate Access Control Report
──────────────────────────────────────────────────
Routes scanned: 28
[CRITICAL] Access control regression: POST /impersonate/:userId
  File:   src/api/admin.ts:12
  Before: requireSuperuser
  After:  (none)
  Impact: POST /impersonate/:userId no longer enforces any access control. This endpoint is now publicly accessible.
──────────────────────────────────────────────────
Authorization changes detected:
  CRITICAL
    POST /impersonate/:userId   requireSuperuser -> (none)
Verdict: FAIL
```

## What Prodgate detects

**CRITICAL — fails CI:**
- Route lost auth middleware
- Router mount lost auth middleware (all child routes affected)
- New unprotected POST, PUT, DELETE, or PATCH route
- Auth middleware order changed
- Unprotected route shadows a protected route on the same path

**WARNING — informational by default, fails CI with `--strict`:**
- New unprotected GET route
- Inconsistent protection across sibling routes

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--github` | Output GitHub markdown for PR comments |
| `--output <file>` | Write output to a file |
| `--strict` | Fail CI on warnings as well as criticals |

## CI Integration

Add this to your repository at `.github/workflows/prodgate.yml`:

```yaml
name: Prodgate Access Control Check

on:
  pull_request:
    branches: [main, master]

jobs:
  prodgate:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout PR branch
        uses: actions/checkout@v4
        with:
          path: after

      - name: Checkout base branch
        uses: actions/checkout@v4
        with:
          ref: ${{ github.base_ref }}
          path: before

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install prodgate
        run: npm install -g prodgate

      - name: Run prodgate check
        run: prodgate check --before ./before --after ./after --json --output prodgate-result.json
        continue-on-error: true

      - name: Post PR comment
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs')
            if (!fs.existsSync('prodgate-result.json')) return
            const result = JSON.parse(fs.readFileSync('prodgate-result.json', 'utf8'))
            const verdict = result.verdict === 'pass' ? 'PASS' : 'FAIL'
            let body = `## Prodgate Access Control Check: ${verdict}\n\n`
            body += `**${result.stats.routesScanned} routes scanned**\n\n`
            const criticals = result.findings.filter(f => f.severity === 'CRITICAL')
            const warnings = result.findings.filter(f => f.severity === 'WARNING')
            if (criticals.length === 0 && warnings.length === 0) {
              body += `No access control issues detected.\n`
            }
            if (criticals.length > 0) {
              body += `### Critical Issues\n\n`
              for (const f of criticals) {
                body += `**\`${f.route.method.toUpperCase()} ${f.route.path}\`** — ${f.message}\n`
                body += `- Before: \`${f.auth.beforeEffective.join(' -> ') || '(none)'}\`\n`
                body += `- After: \`${f.auth.afterEffective.join(' -> ') || '(none)'}\`\n\n`
              }
            }
            if (warnings.length > 0) {
              body += `### Warnings\n\n`
              for (const f of warnings) {
                body += `- \`${f.route.method.toUpperCase()} ${f.route.path}\` — ${f.message}\n`
              }
            }
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            })

      - name: Fail if critical issues detected
        run: |
          node -e "
            const fs = require('fs');
            const result = JSON.parse(fs.readFileSync('prodgate-result.json', 'utf8'));
            if (result.verdict === 'fail') {
              console.log('Prodgate detected critical access control regressions.');
              process.exit(1);
            }
            console.log('Prodgate check passed.');
          "
```

## Zero config

Prodgate auto-detects Express route files by scanning your repository. No configuration required.

If auto-detection doesn't work for your project structure, create a `prodgate.config.json` at the repo root:

```json
{
  "routesDir": "src/routes",
  "authPatterns": ["requireAuth", "requireAdmin"],
  "ignore": ["/health", "/metrics"]
}
```

## Limitations

- Express only. NestJS, FastAPI, and Rails support is planned.
- Static analysis only — does not execute code or make network requests.
- Middleware identity is name and structure based. Renamed or wrapped middleware may not be detected correctly.
- Dynamic route registration patterns may be missed.
- Router-to-route matching uses naming conventions. Unusual naming may require `routesDir` configuration.

## Demo

See [prodgate-demo](https://github.com/prodgate-dev/prodgate-demo) for two worked examples with real CLI output.