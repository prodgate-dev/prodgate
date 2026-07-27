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
aws_dynamodb_table: { category: 'database' },
```

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
  id: 'my-rule',
  appliesTo: (type) => type === 'aws_db_instance',
  evaluate: (before, after) =>
    after?.publicly_accessible === true && before?.publicly_accessible !== true
      ? { severity: 'CRITICAL', summary: 'makes a database publicly accessible', attribute: 'publicly_accessible' }
      : null,
}
```

- `appliesTo(type)` returns true for the resource types the rule looks at.
- `evaluate(before, after)` returns a match, or `null` when the rule does not apply.
- The rule runs on creates and replaces as well as updates, so `before` can be null.
  Check for that, and only fire when the resulting state is actually risky.
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

`npm test` runs the classification suite. Keep it green, and add to it with every
change. To see the output for a plan while you work:

```bash
node dist/cli.js check test/fixtures/my-case.json --github
```

## Pull requests

Fork, branch, and open a PR against `main`. Keep the change focused: a resource type
or a rule plus its tests is a perfect PR. Describe what real change the rule catches
and confirm `npm test` passes.
