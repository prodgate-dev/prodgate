# GitHub Action reference

## Inputs

| Input | Required | Default | Meaning |
|-------|----------|---------|---------|
| `plan-json` | no | `plan.json` | Path to a `terraform show -json` plan file. |
| `mode` | no | `enforce` | `enforce` or `audit`. |
| `fail-on` | no | `critical` | `critical`, `warning`, or `never`. |
| `github-token` | no | `${{ github.token }}` | Token used to post the pull-request comment and clear the override label. |

If the plan file is missing, the check fails with exit code 2 and tells you how to
generate it. Prodgate does not search the workspace for another JSON file, because
evaluating the wrong document would be worse than failing.

## Outputs

| Output | Meaning |
|--------|---------|
| `policy-verdict` | `pass` or `fail`, from the findings and the threshold. Independent of mode. |
| `would-block` | `true` when the findings cross the threshold, before mode or override is applied. |
| `execution-outcome` | `allowed`, `blocked`, `reported` (audit saw a failure), or `overridden`. |
| `enforcement-mode` | `audit` or `enforce`. |
| `exit-code` | `0` allowed or reported, `1` policy block, `2` input, configuration, or tool error. |
| `critical-count`, `warning-count` | Finding counts. |
| `plan-hash` | SHA-256 of the evaluated plan text. |
| `policy-digest` | SHA-256 of the effective policy. |
| `report-path` | Path to the written Markdown report. |
| `engine-version` | The Prodgate version that ran. |

## Read an output in a later step

The Prodgate step fails when it blocks. Without `always()`, GitHub applies `success()`
and skips a later step that reads an output.

```yaml
      - name: Prodgate
        id: prodgate
        uses: prodgate-dev/prodgate@v1

      - name: Notify on a block
        if: ${{ always() && steps.prodgate.outputs.execution-outcome == 'blocked' }}
        run: echo "Blocked ${{ steps.prodgate.outputs.critical-count }} critical change(s)"
```

## Required permissions

```yaml
permissions:
  contents: read
  pull-requests: write
```

`pull-requests: write` is required. Commenting on a pull request needs the
pull-requests permission even though the REST path is `/issues/{number}/comments`.
With `issues: write` alone the comment request returns 403 and no comment appears.

## Recommended events

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
```

`labeled` lets the override take effect in the run that adds the label. `unlabeled`
re-runs the gate when the label is removed.

## Workflow safety

Running `terraform plan` on a pull request runs code the pull-request author controls,
including provider and module code. Treat that job as untrusted.

- Add Prodgate after an existing trusted job that already produces a plan, rather than
  planning again.
- Do not give a job that plans pull-request code any privileged cloud credentials. Use
  a read-only role scoped to planning. Put anything stronger behind an environment with
  required reviewers.
- Keep `persist-credentials: false` on checkout so a later step cannot reuse the git
  token.
- Never upload `plan.json` as a workflow artifact. Anyone with read access to the
  repository can download an artifact, and on a public repository it is publicly
  reachable for the whole retention period.
- To separate privileges, use two jobs and move only the sanitized report. The first
  job has no write permissions: it generates the plan, runs Prodgate, writes the report
  with `--output`, and deletes the plan file. The second job takes that report and holds
  the commenting permission. The report and the JSON envelope omit resource values, so
  they are safe to pass between jobs in a way the raw plan is not.

## Pin third-party actions

Pin to a commit SHA and record the release version in a comment.

```yaml
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
```

## Fork pull requests

GitHub gives a fork pull request a read-only token. Prodgate still evaluates the plan
and still sets the correct check status. The comment and the label cleanup return 403,
and that failure does not change the policy result: a blocked plan stays blocked, and a
passing plan stays passing.

A leftover override label on a fork pull request grants nothing after a new commit,
even when the read-only token cannot remove the label.
