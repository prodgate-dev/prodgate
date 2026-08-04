# CLI reference

Install once, or run it with `npx`.

```bash
npm install -g prodgate
```

## Commands

```bash
prodgate check plan.json           # evaluate a plan
prodgate doctor [plan.json]        # check the setup and whether a plan is usable
prodgate coverage [--json]         # what Prodgate evaluates
prodgate explain PG-AWS-RDS-PUBLIC # what a rule flags and cannot tell
prodgate diagnostics plan.json     # sanitized metadata for a bug report
```

## check

Generate a plan in JSON form, then evaluate it.

```bash
terraform show -json plan.tfplan > plan.json
prodgate check plan.json
```

The result is a report on standard output and an exit code.

| Flag | Meaning |
|------|---------|
| `--mode <audit\|enforce>` | Enforcement mode. Default `enforce`. |
| `--fail-on <critical\|warning\|never>` | Blocking threshold. Default `critical`. |
| `--json` | Print the JSON evaluation envelope. |
| `--github` | Print GitHub-flavored Markdown for a pull-request comment. |
| `--output <file>` | Write the report to a file instead of standard output. |
| `--outputs-file <file>` | Append `key=value` CI outputs to a file. |
| `--override` | Record a manual override. Findings are still reported. |
| `--config <file>` | Path to `prodgate.config.json`. |
| `--color` | Force ANSI color when the output is not a terminal. |
| `--pr-author`, `--branch`, `--commits-file`, `--pr-body-file` | Metadata for AI-agent detection. |

`--strict` and `--approved` remain as deprecated aliases for `--fail-on warning` and
`--override`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | The plan is allowed, or audit mode reported a failure without blocking. |
| `1` | A policy block. The findings crossed the threshold in enforce mode. |
| `2` | An input, configuration, or tool error. Prodgate could not evaluate the plan. |

Exit code 2 is not a statement that the change is safe. Treat it as a broken gate.

## doctor

Check the local setup before you debug a workflow.

```bash
prodgate doctor plan.json
```

It reports the Node version, the engine and policy version, whether a config file is
valid, the CI environment, and whether the plan parses and has managed changes.

| Code | Meaning |
|------|---------|
| `0` | The setup and the supplied inputs are usable. |
| `1` | An advisory that does not stop an evaluation. |
| `2` | A blocker. A named plan or config is missing or unusable, or the runtime is unsupported. |

A valid plan with no managed changes is a note, not a problem.

## coverage

List the resource types and rules Prodgate evaluates. The list is generated from the
rule tables, so it cannot drift from the behavior.

```bash
prodgate coverage
prodgate coverage --json
prodgate coverage --provider aws
```

## explain

Explain any rule ID that can appear in a finding.

```bash
prodgate explain PG-DESTROY-STATEFUL
prodgate explain PG-AWS-SG-WORLD-OPEN --json
```

The output gives the category, the default and possible severities, the actions the
rule applies to, the evidence fields, why Prodgate flags it, and what Prodgate cannot
determine from a plan.

## diagnostics

Produce metadata for a bug report without sharing your plan.

```bash
prodgate diagnostics plan.json
prodgate diagnostics plan.json --finding PG-AWS-RDS-PUBLIC
```

The output contains rule IDs, resource types, actions, and normalized evidence tokens.
It never contains resource addresses, names, tags, or attribute values, so it is safe
to paste into an issue. See [reporting.md](reporting.md).

If `--finding` matches nothing, the command exits 2 and lists the rules the plan did
produce. That distinguishes a mistyped rule ID from a rule that did not fire.
