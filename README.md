# Prodgate

Block destructive infrastructure changes in CI before they ship.

<p align="center">
  <img src="https://raw.githubusercontent.com/prodgate-dev/prodgate/main/demo/prodgate.gif" alt="Prodgate reads a Terraform plan and blocks an AI agent's attempt to delete the production database" width="760">
</p>

Prodgate reads a Terraform/OpenTofu plan and fails the build when a change would destroy or expose production data, especially when an AI agent generated the change. It is a CI gate, not a scanner: it reasons about the *change*, not the static config.

It works out of the box with no rules to write, and it reads the plan as a file: it never runs Terraform and never needs your cloud credentials.

## Quickstart

1. Try it locally against a real plan:
   ```bash
   terraform show -json plan.tfplan > plan.json
   npx prodgate check plan.json
   ```
2. Create the override label once, so the override flow works when you need it:
   ```bash
   gh label create prodgate-approved --description "Recorded manual Prodgate override" --color D93F0B
   ```
3. Add the Action to your pull-request workflow (see below).
4. Run it in **audit mode** for a week (`mode: audit`): it reports what it would block without failing the build.
5. Review the findings. If it is quiet and accurate, remove the `mode: audit` line to enforce.
6. From then on, a critical finding fails the check until a reviewer adds the `prodgate-approved` label.

Exit codes: `0` allowed or reported, `1` a policy block, `2` an input, configuration, or tool error. A `2` means Prodgate could not evaluate the plan, not that the plan is safe.

## Why

A common, dangerous PR drops a production database, replaces a volume, disables deletion protection, or opens a security group to the world. In a diff it can look routine, and it shows up increasingly often in AI-generated changes. Prodgate turns that into a failed check with a recorded manual override.

## Usage (GitHub Actions)

Two steps: your pipeline already produces a plan; Prodgate reads it.

```yaml
name: Prodgate

on:
  pull_request:
    # `labeled` lets the override take effect in the run that adds the
    # prodgate-approved label; `unlabeled` re-runs the gate when it is removed.
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write   # to post and update the PR comment and clear the override label

jobs:
  prodgate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0            # lets Prodgate see commit co-author trailers for agent detection
          persist-credentials: false # do not leave a usable git token in the workspace

      - uses: hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd # v3

      # Your existing plan, with your credentials. Prodgate never sees them.
      - name: Terraform plan
        run: |
          terraform init -input=false
          terraform plan -out=plan.tfplan -input=false
          terraform show -json plan.tfplan > plan.json

      - name: Prodgate
        uses: prodgate-dev/prodgate@v1
        with:
          plan-json: plan.json

      # A plan can contain secrets in plaintext. Remove it once Prodgate has read it.
      - name: Remove plan file
        if: always()
        run: rm -f plan.json plan.tfplan
```

On every PR, Prodgate posts a one-line plan summary (what the change adds, changes, replaces, and destroys), so the check is useful even when nothing is wrong. On a destructive or dangerous change, it fails the check and posts the detail. To let a flagged change through, add the **`prodgate-approved`** label to record a manual override (see below).

**Workflow safety.** The example above is a starting point. Running `terraform plan` on a pull request executes code the PR author controls, including provider and module code, so treat that job as untrusted:

- If you already have a trusted job that produces a plan, add Prodgate after it rather than planning again here.
- Do not expose privileged cloud credentials to a job that plans PR-authored code. Use a read-only role scoped to planning, and prefer an environment with required reviewers for anything stronger.
- Keep `persist-credentials: false` on checkout so a later step cannot reuse the git token.
- Grant the smallest permissions that work. Prodgate needs `issues: write` for the comment and the override label, and nothing more.
- Never upload `plan.json` as a workflow artifact. Anyone with read access to the repository can download artifacts, and on a public repository they are publicly reachable, so a plan holding a plaintext password or token would be exposed for the whole retention period.
- For stronger separation, split it into two jobs and move only the sanitized output. The first job has no write permissions: it generates the plan, runs Prodgate immediately, writes the Markdown report with `--output`, and deletes the plan file. The second job takes only that report and holds the `issues: write` permission for commenting. Prodgate's report and JSON envelope omit resource values, so they are safe to pass between jobs in a way the raw plan is not.

**Audit-first rollout.** Prodgate enforces by default: a critical finding fails the check. On an existing or production repository, run it in audit mode for a week first by adding `mode: audit` to the step. In audit mode the check reports what it would have blocked but does not fail the build. When you are confident it is not noisy, remove that line to enable enforcement.

```yaml
      - name: Prodgate
        uses: prodgate-dev/prodgate@v1
        with:
          plan-json: plan.json
          mode: audit   # remove to enforce
```

## Usage (CLI)

```bash
npm install -g prodgate
terraform show -json plan.tfplan > plan.json
prodgate check plan.json
```

Example output:

```
Prodgate Infrastructure Change Report
──────────────────────────────────────────────────
Resources scanned: 1
Plan summary: 0 to add, 0 to change, 1 to destroy

[CRITICAL] 1 destructive or dangerous change

  DELETE   aws_db_instance.main               deletes a stateful resource (data-loss risk)

──────────────────────────────────────────────────
Verdict: FAIL
```

## Sensitive plan data

A Terraform plan can contain secrets in plaintext (passwords, keys, tokens), even when the normal `terraform plan` output marks those values as sensitive. Prodgate reads the plan locally, never uploads it, and its reports omit resource values by default. To keep the plan file itself safe:

- Do not commit `plan.json` to the repository (add it to `.gitignore`).
- Do not print the full plan JSON to public CI logs.
- Restrict access to any CI artifact that contains a plan, and keep its retention short.
- Remove the plan file after the check runs, as the example workflow does.

## No telemetry

Prodgate does not transmit Terraform plan contents, findings, repository metadata, or usage analytics anywhere. It runs locally and collects no telemetry. If a future feature ever sends anything, it will be opt-in and separately documented. The GitHub Action does call the GitHub API to post the PR comment and to read or clear the override label, using the token you provide; that is the Action interacting with your own repository, not Prodgate telemetry.

## What Prodgate flags

**CRITICAL (fails CI):**
- Deleting or replacing a stateful resource (databases, volumes, buckets, DNS zones, KMS keys, secrets, log groups). Critical by default in any environment, because whether the data can be recovered depends on backups, snapshots, or versioning that the plan cannot see.
- Deleting or replacing a production-tagged resource.
- Disabling deletion protection.
- Making a database publicly accessible (on update or create).
- Weakening an S3 public access block.
- Opening a sensitive port (SSH, RDP, database ports) to `0.0.0.0/0` or `::/0` (on update or create).

**WARNING (informational by default, blocks with `--fail-on warning`):**
- Deleting or replacing a stateful resource **only** when it carries an explicit non-production tag (`Environment=dev/test/qa/staging/preview/sandbox/ephemeral`) and is not otherwise protected. Untagged or prod-looking resources stay CRITICAL; a declared dev teardown drops to WARNING so it does not cry wolf, but is still shown. A resource with `deletion_protection` on stays CRITICAL regardless of tags.
- Deleting or replacing a non-stateful, non-production resource.
- Opening a non-sensitive port to the world.
- Granting a wildcard (`*`) IAM action or resource.
- Cannot verify a security-critical change because the resulting value is computed and unknown at plan time. Covered rules: deletion protection, database public access, S3 public access block, security-group ingress, and IAM policy wildcards.

## AI-agent detection

When a flagged change looks agent-generated, Prodgate says so and shows the signal it matched (a `Co-Authored-By` trailer from Claude Code / Cursor, a bot author, an agent branch prefix). It is a transparent flag, never a black box.

## Manual override using a GitHub label

Adding the `prodgate-approved` label applies a repository-controlled manual override: the finding is still reported, but the gate passes. It is honored only in the run for the event that added the label (re-running that same run keeps the same event and plan head SHA, so it stays valid). Opening, reopening, or pushing a new commit is a different event, so a leftover label never passes a plan on its own. After a new commit, remove and re-add the label.

This is an override, not a verified approval. GitHub repository permissions determine who can apply the label. Prodgate does not verify separation of duties, team membership, whether the actor reviewed the plan, or whether the plan later applied matches this one. The report and the JSON envelope record the label, the triggering actor, and the plan head SHA so the override is auditable, not that it is authorized.

## Configuration

Zero-config by default. For overrides, add `prodgate.config.json`:

```json
{
  "schemaVersion": 1,
  "mode": "enforce",
  "failOn": "critical",
  "ignore": ["module.sandbox.*"],
  "allowDestruction": ["aws_db_instance.scratch"]
}
```

`mode` is `enforce` or `audit`. `failOn` is `critical`, `warning`, or `never`. `ignore` skips resources entirely; `allowDestruction` suppresses only the destruction finding for a resource, not exposure findings on its recreate.

| Flag | Description |
|------|-------------|
| `--json` | Output the JSON evaluation envelope |
| `--github` | Output GitHub markdown for PR comments |
| `--output <file>` | Write output to a file |
| `--mode <mode>` | `audit` or `enforce` (default `enforce`) |
| `--fail-on <level>` | `critical`, `warning`, or `never` (default `critical`) |
| `--override` | Record a manual override (gate passes; findings still reported) |
| `--config <file>` | Path to `prodgate.config.json` |

## JSON output

`--json` emits a stable, versioned envelope for integrations. It never includes raw plan values, keeps a deterministic finding order, and separates the policy verdict from the enforcement outcome:

```json
{
  "schemaVersion": "1.0",
  "engine": { "name": "prodgate", "version": "1.0.0" },
  "policy": { "version": "aws-default-v1", "digest": "sha256:..." },
  "plan": { "formatVersion": "1.2", "terraformVersion": "1.9.5", "hash": "sha256:..." },
  "enforcement": { "mode": "enforce", "failOn": "critical", "policyVerdict": "fail", "wouldBlock": true, "executionOutcome": "blocked" },
  "stats": { "resourcesScanned": 9, "created": 6, "updated": 2, "replaced": 0, "destroyed": 1, "criticalCount": 1, "warningCount": 0 },
  "findings": [{ "ruleId": "PG-DESTROY-STATEFUL", "severity": "CRITICAL", "category": "data_loss", "confidence": "high", "resource": { "address": "aws_db_instance.main", "type": "aws_db_instance" }, "action": "delete", "evidence": [{ "field": "change.actions", "observed": "delete" }] }]
}
```

`enforcement.executionOutcome` is `allowed`, `blocked`, `reported` (audit mode saw a failure), or `overridden`. `enforcement.policyVerdict` is the decision from the findings, independent of mode. When an override is applied, `enforcement.override` records the label, triggering actor, and plan head SHA. Findings are sorted by severity, then rule id, resource address, and action, so the order is stable across runs. `stats.destructive` and `stats.dangerous` count findings, not resources.

An invalid plan or config instead prints `{ "error": { "code": "...", "message": "..." } }` and exits 2. Under GitHub Actions the envelope also carries a `source` block (repository, commit SHA of the PR head, workflow run, pull request). See [docs/json-envelope.md](docs/json-envelope.md) for the full field reference and compatibility rules.

## Action outputs

The Action exposes outputs so later steps can react without parsing the comment:

| Output | Meaning |
|--------|---------|
| `policy-verdict` | `pass` or `fail` from the findings and fail-on |
| `would-block` | `true` if this would block in enforce mode |
| `execution-outcome` | `allowed`, `blocked`, `reported`, or `overridden` |
| `enforcement-mode` | `audit` or `enforce` |
| `exit-code` | `0` allowed/reported, `1` policy block, `2` input/configuration/tool error |
| `critical-count`, `warning-count` | finding counts |
| `plan-hash`, `policy-digest` | the plan and effective-policy digests |
| `report-path` | path to the Markdown report |
| `engine-version` | the Prodgate version that ran |

```yaml
      - name: Prodgate
        id: prodgate
        uses: prodgate-dev/prodgate@v1
        with:
          plan-json: plan.json
      - name: Notify on a block
        # always() is needed because the Prodgate step fails on a block; without it
        # GitHub applies success() and skips this step.
        if: ${{ always() && steps.prodgate.outputs.execution-outcome == 'blocked' }}
        run: echo "Blocked ${{ steps.prodgate.outputs.critical-count }} critical change(s)"
```

## Other commands

```bash
prodgate doctor [plan.json]        # check the local setup and whether a plan is usable
prodgate coverage [--json]         # what Prodgate evaluates: resource types and rules
prodgate explain PG-AWS-RDS-PUBLIC # what a rule flags, when, and what it cannot tell
prodgate diagnostics plan.json     # sanitized metadata for a bug report, no plan values
```

`diagnostics` prints only rule ids, resource types, actions, and normalized evidence tokens. It never includes resource addresses, names, tags, or attribute values, so it is safe to paste into an issue. Use it with `--finding <ruleId>` to report one specific result.

## Trust boundary

Prodgate reads a plan JSON file. It does not run Terraform, does not read your state, and never needs cloud credentials. It cannot do anything to your account; it can only read the plan.

## Threat model

Be clear about what a CI gate does and does not defend against. The PR branch controls both the workflow file and the step that produces `plan.json`, so a PR author can, in principle, feed Prodgate a benign plan or remove the step. Prodgate therefore defends against **mistakes and oversight** — the routine destructive change buried in a diff, or an AI agent that deletes the wrong thing — not against an adversary who is deliberately subverting their own CI.

To raise Prodgate from an accident-catcher toward an enforcement control:

- Make the Prodgate check **required** in branch protection, so a PR cannot merge without it.
- Put `.github/workflows/` under **CODEOWNERS** so changes to the workflow itself need review.
- Generate `plan.json` from the merge result in a trusted job, not from author-controlled output.

These are standard for any CI-side policy check (OPA, Checkov, and others share the same boundary); naming it is more honest than implying the gate is tamper-proof.

## Provider coverage

| Surface | Coverage |
|---------|----------|
| Terraform plan JSON | Supported and tested against real `terraform show -json` output |
| OpenTofu plan JSON | Supported and tested against real `tofu show -json` output |
| AWS resources | Supported (stateful resources, public DB, S3 public access, security groups, IAM, deletion protection) |
| GCP / Azure | Planned |
| Pulumi / CDK / CloudFormation | Not supported |

Coverage is a data table (`src/resources.ts`), so adding a resource type or a risk rule is an edit, not a rewrite. Run `prodgate coverage` (or `prodgate coverage --json`) to see exactly which resource types and rules are evaluated.

## How this compares

Prodgate is not a policy platform, and it does not pretend OPA, Sentinel, Checkov, Atlantis, or Terraform Cloud do not exist. Those are broader and more configurable. Prodgate is narrower on purpose: no policy language, plan-first, and tuned for high-signal destructive or exposing changes in a PR.

- Use OPA / Sentinel / Checkov if you want a full policy engine and are willing to write and maintain policy.
- Use Prodgate if you want a five-minute guardrail that fails CI when a plan deletes a database or opens something to the world, with nothing to configure.

## Limitations

- Terraform and OpenTofu only (Pulumi, CDK, and others are planned).
- AWS-first resource coverage. Other providers are added by extending the knowledge base.
- It reasons about the change in the plan (delete, replace, create, update), not resources that are unchanged (no-op) in the plan.
- Static analysis of the plan; it does not execute anything.

## Contributing

Adding a resource type or a rule is usually a one-line edit to a data table, not an engine change. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the knowledge base is organized and how to add coverage with a test.

## Demo

See `examples/agent-deletes-prod` for a worked plan where an AI agent deletes the production database and Prodgate blocks it.
