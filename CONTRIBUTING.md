# Contributing to Prodgate

Thanks for helping make Prodgate catch more real problems. Most contributions are
small: adding a resource type or a rule is editing a data table, not writing engine
code. This guide shows you where things live and how to add coverage.

## The one rule that matters

Prodgate only earns its place in CI if people trust it not to cry wolf. A check
that blocks safe plans gets disabled, and then it protects nothing. So the bar for
any new rule is: **it must not fire on a safe plan.** When in doubt, make a change a
WARNING rather than a CRITICAL, or leave it out. Every rule ships with a test that
proves both what it catches and what it leaves alone.

## Where coverage lives

The knowledge base is `src/resources.ts`. It is data, not logic, so adding coverage
is editing a table:

- `STATEFUL_RESOURCES` — resource types whose delete or replace destroys data.
- `DANGEROUS_MUTATIONS` — before/after rules for risky in-place changes.
- `DISRUPTIVE_REPLACE` — resource types whose replace interrupts service.

The decisions that read these tables are in `src/policy.ts`, and the pass/fail
verdict is in `src/classify.ts`. You rarely need to touch those.

## Add a stateful resource type

Deleting or replacing one of these is treated as data loss (CRITICAL, in any
environment). Add a line to `STATEFUL_RESOURCES` with a category:

```ts
aws_dynamodb_table: {
  category: 'database',
  defaultSeverity: 'CRITICAL',
  rationale: 'the table holds its items',
},
```

The rationale is a short phrase. It is composed into a sentence that already says the
change may cause data loss and that recovery depends on backups, so write only the
resource-specific part.

## Add a disruptive-replace resource type

Replacing one of these interrupts service even when no data is lost. It produces an
informational note in the plan summary. It does not create a finding and does not
fail the build. Add a line to `DISRUPTIVE_REPLACE`:

```ts
aws_lb: { category: 'load-balancer' },
```

Do not list stateful types here. Their replace is already CRITICAL for data loss, so
a disruption note would be redundant.

## Add a dangerous-mutation rule

These catch a change that leaves a resource in a risky state, such as a database made
public or a security group opened to the world. A rule is an object in the
`DANGEROUS_MUTATIONS` array:

```ts
{
  id: 'PG-AWS-MY-RULE',
  meta: {
    category: 'exposure',
    defaultSeverity: 'CRITICAL',
    possibleSeverities: ['CRITICAL', 'WARNING'],
    severityCondition: 'warning when the resulting value is unknown at plan time',
    actions: ['create', 'update', 'replace'],
    resourceTypes: ['aws_db_instance'],
    evidenceFields: ['after.publicly_accessible'],
    rationale: 'Making a database publicly accessible exposes it to the internet.',
    limitations: ['Cannot confirm the resulting value when it is computed at plan time.'],
  },
  appliesTo: (type) => type === 'aws_db_instance',
  evaluate: (before, after, afterUnknown) => {
    if (after?.publicly_accessible === true && before?.publicly_accessible !== true) {
      return {
        severity: 'CRITICAL',
        category: 'exposure',
        confidence: 'high',
        summary: 'makes a database publicly accessible',
        attribute: 'publicly_accessible',
        evidence: [{ field: 'after.publicly_accessible', observed: 'true' }],
      }
    }
    return null
  },
}
```

- `id` is stable and never reassigned to different semantics.
- `meta` is what `prodgate coverage` publishes, and `meta.actions` also gates
  execution, so list only the change kinds the rule can actually fire on. A rule that
  needs a prior state, such as one detecting a protection being turned off, must not
  list `create`.
- `meta.rationale` says why Prodgate flags it; `meta.limitations` say what Prodgate
  cannot determine from a plan.
- `appliesTo(type)` returns true for the resource types the rule looks at.
- `evaluate(before, after, afterUnknown)` returns a match, or `null`. On a create
  `before` is null, so check for that and only fire when the resulting state is risky.
- If the rule depends on a field that is computed at plan time, do not assume it is
  safe. Use the shared `indeterminate(...)` helper to report it for review.
- `evidence` names the plan facts that produced the finding, using normalized tokens
  rather than raw values.
- Use CRITICAL for something that loses or exposes data, WARNING for something worth
  a look that should not block on its own.

## Add a test

Every rule needs a fixture and an assertion. Fixtures are Terraform plan JSON files
in `test/fixtures/`, and the runner is `test/case_plan.ts`.

1. Add a plan fixture, for example `test/fixtures/my-case.json`. The smallest useful
   plan is a single entry in `resource_changes` with the `change.actions` and the
   `before`/`after` your rule reads. Copy an existing fixture to see the shape.
2. Add a `check(...)` line in `test/case_plan.ts` asserting the verdict and the
   finding you expect.
3. Add a second fixture and assertion for a nearby safe case that must NOT fire.
   This is the part that keeps the tool trustworthy.

## Run it locally

```bash
npm install
npm run build
npm test
```

`npm test` runs the classification and CLI suites (it builds first). `npm run typecheck`
runs the strict TypeScript check over the source and the tests. Strict TypeScript is
the static-analysis gate for this project; there is no separate linter. Keep both
green, and add tests with every change. To see the output for a plan while you work:

```bash
node dist/cli.js check test/fixtures/my-case.json --github
```

## Pull requests

Fork, branch, and open a PR against `main`. Keep the change focused: a resource type
or a rule plus its tests is a perfect PR. Describe what real change the rule catches
and confirm `npm test` passes.
