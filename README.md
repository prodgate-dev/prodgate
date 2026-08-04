# Prodgate

A deterministic approval and evidence layer for infrastructure changes made by humans and AI agents.

Prodgate reads Terraform/OpenTofu plans and blocks destructive or dangerous changes before they are applied.

It reads the plan locally. It does not run Terraform and does not need cloud credentials.

<p align="center">
  <img src="https://raw.githubusercontent.com/prodgate-dev/prodgate/main/demo/prodgate.gif" alt="Prodgate reads a Terraform plan and blocks a change that deletes a production database" width="760">
</p>

## The problem

An infrastructure diff can look routine and still delete a database, replace a volume, or expose a resource to the internet. The change is harder to review when an AI agent wrote it. Prodgate turns that change into a failed check with a recorded override.

## Quickstart

Add this to a pull-request workflow. Your pipeline produces the plan. Prodgate reads it.

```yaml
name: Prodgate

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  prodgate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - run: terraform show -json plan.tfplan > plan.json

      - uses: prodgate-dev/prodgate@v1
```

`pull-requests: write` is required. Prodgate posts one comment per pull request and updates it. `plan-json` defaults to `plan.json`; set it if your plan is elsewhere.

A plan file can contain secrets in plaintext. Add a step to delete it, and create the override label once:

```yaml
      - name: Remove plan file
        if: always()
        run: rm -f plan.json plan.tfplan
```

```bash
gh label create prodgate-approved --description "Recorded manual Prodgate override" --color D93F0B
```

To try Prodgate on your machine first:

```bash
terraform show -json plan.tfplan > plan.json
npx prodgate check plan.json
```

## Default behavior

Prodgate enforces critical findings by default. You do not need a policy file.

| Default | Behavior |
|---|---|
| Stateful resource delete or replace | Critical; fails CI |
| Production-tagged destruction | Critical; fails CI |
| Public database exposure | Critical; fails CI |
| Weak S3 public-access protection | Critical when all protections are known false; warning when a security-critical result is unknown |
| Public sensitive-port ingress | Critical |
| Unknown security-critical value | Warning; requires review |
| No managed changes | Pass with an explicit no-managed-changes message |
| Invalid or unrecognized plan | Exit 2; never passes |

Exit code 2 means Prodgate could not evaluate the plan. It never means the change is safe.

## A blocked result

```text
[CRITICAL] DELETE aws_db_instance.main
May cause data loss. Recovery depends on backups, snapshots,
replication, retention or versioning that Prodgate cannot verify.

Verdict: FAIL
```

Prodgate reports a data-loss risk. It does not claim the data is unrecoverable.

## Audit-first rollout

Run Prodgate in audit mode on an existing repository first.

```yaml
      - uses: prodgate-dev/prodgate@v1
        with:
          mode: audit
```

Audit mode reports what enforcement would block without failing the check. Remove `mode: audit` when the findings are trusted.

## Override a finding

Add the `prodgate-approved` label to the pull request. The finding stays reported and the gate passes. The override applies only to the run for the event that added the label, and a new commit invalidates it. This is a recorded override, not a verified approval. See the [threat model](docs/threat-model.md).

## Zero-policy configuration

Prodgate uses a built-in policy. You do not need to write rules. Add `prodgate.config.json` only when you need exceptions, audit mode, or a different failure threshold.

```json
{
  "schemaVersion": 1,
  "ignore": ["module.sandbox.*"],
  "allowDestruction": ["aws_db_instance.scratch"]
}
```

See [configuration](docs/configuration.md) for every option.

## Safety and data boundary

- Prodgate reads a plan file locally. It does not run Terraform and does not need cloud credentials.
- It does not upload plan contents and collects no telemetry. Reports omit resource values.
- Plan files can contain secrets. Delete or protect them after use.
- Prodgate catches mistakes and oversight. It is not a defense against a pull request that changes its own workflow.

Read [sensitive plan data](docs/sensitive-plans.md) and the [threat model](docs/threat-model.md) before you roll this out widely.

## Coverage

Prodgate supports Terraform and OpenTofu plans, with AWS resource coverage. GCP and Azure are not supported yet. Run `prodgate coverage` to list the resource types and rules it evaluates, and `prodgate explain <ruleId>` to see what one rule flags and what it cannot determine.

## Documentation

- [Configuration](docs/configuration.md)
- [Action inputs and outputs](docs/action.md)
- [CLI usage](docs/cli.md)
- [JSON output](docs/json-envelope.md)
- [Coverage and rules](docs/coverage.md)
- [Sensitive plan data](docs/sensitive-plans.md)
- [Threat model](docs/threat-model.md)
- [Reporting a wrong finding](docs/reporting.md)
- [Contributing](CONTRIBUTING.md)

See `examples/agent-deletes-prod` for a worked plan where an AI agent deletes a production database and Prodgate blocks it.
