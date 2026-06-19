# Prodgate

Block destructive infrastructure changes in CI before they ship.

Prodgate reads a Terraform/OpenTofu plan and fails the build when a change would irreversibly destroy production data or expose it, especially when an AI agent generated the change. It is a CI gate, not a scanner: it reasons about the *change*, not the static config.

It works out of the box with no rules to write, and it reads the plan as a file: it never runs Terraform and never needs your cloud credentials.

## Why

A common, dangerous PR drops a production database, replaces a volume, disables deletion protection, or opens a security group to the world. In a diff it can look routine, and it shows up increasingly often in AI-generated changes. Prodgate turns that into a failed check with a recorded human override.

## Usage (GitHub Actions)

Two steps: your pipeline already produces a plan; Prodgate reads it.

```yaml
name: Prodgate

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  prodgate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0   # lets Prodgate see commit co-author trailers for agent detection

      - uses: hashicorp/setup-terraform@v3

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
```

On a destructive or dangerous change, Prodgate fails the check and posts a PR comment. A human approves by adding the **`prodgate-approved`** label (GitHub records who and when); re-run the check and the gate passes.

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

[CRITICAL] 1 destructive or dangerous change

  DELETE   aws_db_instance.main               deletes a stateful resource (data loss)

──────────────────────────────────────────────────
Verdict: FAIL
```

## What Prodgate flags

**CRITICAL (fails CI):**
- Deleting or replacing a stateful resource (databases, volumes, buckets, DNS zones, KMS keys, secrets, log groups). Data loss is data loss, in any environment.
- Deleting or replacing a production-tagged resource.
- Disabling deletion protection.
- Making a database publicly accessible.
- Weakening an S3 public access block.
- Opening a sensitive port (SSH, RDP, database ports) to `0.0.0.0/0`.

**WARNING (informational by default, fails CI with `--strict`):**
- Deleting or replacing a non-stateful, non-production resource (so it does not cry wolf on dev teardowns).
- Opening a non-sensitive port to the world.
- Granting a wildcard (`*`) IAM action or resource.

## AI-agent detection

When a flagged change looks agent-generated, Prodgate says so and shows the signal it matched (a `Co-Authored-By` trailer from Claude Code / Cursor, a bot author, an agent branch prefix). It is a transparent flag, never a black box.

## Approval (recorded sign-off)

Destructive changes require a human to approve them. In the Action, that is the `prodgate-approved` label; GitHub records who applied it and when. The finding is still reported; only the verdict flips to pass.

## Configuration

Zero-config by default. For overrides, add `prodgate.config.json`:

```json
{
  "ignore": ["module.sandbox.*"],
  "allowDestroy": ["aws_db_instance.scratch"]
}
```

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--github` | Output GitHub markdown for PR comments |
| `--output <file>` | Write output to a file |
| `--strict` | Also fail on warnings |
| `--approved` | Treat the change as human-approved |
| `--config <file>` | Path to `prodgate.config.json` |

## Trust boundary

Prodgate reads a plan JSON file. It does not run Terraform, does not read your state, and never needs cloud credentials. It cannot do anything to your account; it can only read the plan.

## Limitations

- Terraform and OpenTofu only (Pulumi, CDK, and others are planned).
- AWS-first resource coverage. Other providers are added by extending the knowledge base.
- It flags changes that make things worse (a regression), not the mere existence of a public resource created from scratch.
- Static analysis of the plan; it does not execute anything.

## Demo

See `examples/agent-deletes-prod` for a worked plan where an AI agent deletes the production database and Prodgate blocks it.
