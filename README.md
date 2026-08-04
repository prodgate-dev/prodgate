# Prodgate

> A deterministic approval and evidence layer for infrastructure changes made by humans and AI agents.

Prodgate reads Terraform/OpenTofu plans and blocks destructive or dangerous changes before they are applied.

It reads the plan locally. It does not run Terraform and does not need cloud credentials.

<p align="center">
  <img src="https://raw.githubusercontent.com/prodgate-dev/prodgate/main/demo/prodgate.gif" alt="Prodgate blocks an AI agent's attempt to delete a production database" width="760">
</p>

## Quickstart: GitHub Actions

Add Prodgate after the step that creates your plan.

```yaml
permissions:
  contents: read
  pull-requests: write # needed for the PR comment and override label

steps:
  # Your existing checkout and Terraform plan steps go here.
  - name: Create JSON plan
    run: terraform show -json plan.tfplan > plan.json

  - name: Prodgate
    uses: prodgate-dev/prodgate@v1
    with:
      plan-json: plan.json

  - name: Remove plan file
    if: always()
    run: rm -f plan.json plan.tfplan
```

Prodgate needs a plan file produced by Terraform or OpenTofu. It does not create the plan or apply infrastructure changes.

On a pull request, the Action posts a sanitized summary. A critical finding fails the check. Add the `prodgate-approved` label to record a manual override for that event.

## Features

- **Built-in policy.** Start without a policy file or rules to write.
- **Plan-first decisions.** Prodgate evaluates the planned change, not only the configuration.
- **Deterministic findings.** The same plan and policy produce the same result.
- **Approval evidence.** Reports include the finding, plan hash, policy digest and override details without exposing resource values by default.
- **CI integration.** Use the CLI or the GitHub Action. The Action can post a sanitized pull-request summary.

### Default checks

| Change | Default result |
|---|---|
| Delete or replace a stateful resource | Critical; fails CI |
| Delete or replace a production-tagged resource | Critical; fails CI |
| Make a database public | Critical; fails CI |
| Weaken all S3 public-access protections | Critical; fails CI |
| Open SSH, RDP or database ports to the world | Critical; fails CI |
| Grant a wildcard IAM action or resource | Warning |
| Security-critical value is unknown at plan time | Warning; requires review |
| Valid plan with no managed changes | Pass with an explicit message |
| Invalid or unrecognized plan | Exit 2; never passes |

Prodgate evaluates the change in the plan. It does not judge only the final configuration. A replacement can therefore produce both a destruction finding and a dangerous-creation finding.

Example:

```text
[CRITICAL] DELETE aws_db_instance.main
May cause data loss. Recovery depends on backups, snapshots,
replication, retention or versioning that Prodgate cannot verify.

Verdict: FAIL
```

## Audit mode

Use audit mode when introducing Prodgate to an existing repository:

```yaml
- name: Prodgate
  uses: prodgate-dev/prodgate@v1
  with:
    plan-json: plan.json
    mode: audit
```

Audit mode reports what enforcement would block without failing the check. Remove `mode: audit` when the findings are trusted.

## CLI

Try Prodgate locally:

```bash
npx prodgate check plan.json
```

Or install it globally:

```bash
npm install --global prodgate
prodgate check plan.json
```

Exit codes:

| Code | Meaning |
|---:|---|
| `0` | Allowed or reported in audit mode |
| `1` | Policy blocked the plan |
| `2` | Prodgate could not evaluate the input or configuration |

## Configuration and exceptions

The defaults are `mode: enforce` and `failOn: critical`. No configuration file is required. Add `prodgate.config.json` only when you need an exception or a different enforcement setting:

```json
{
  "schemaVersion": 1,
  "mode": "enforce",
  "failOn": "critical",
  "ignore": ["module.sandbox.*"],
  "allowDestruction": ["aws_db_instance.scratch"]
}
```

`ignore` suppresses all findings for a matching resource. `allowDestruction` suppresses only the destruction finding. A recreated resource can still produce an exposure or dangerous-mutation finding.

See [JSON envelope and integration fields](docs/json-envelope.md) for the stable JSON output and policy/plan digests.

## Manual overrides

The GitHub Action supports the `prodgate-approved` label as a repository-controlled manual override.

The finding remains in the report. The gate passes only for the run triggered by adding the label. A new commit creates a new event and requires a new approval. GitHub permissions determine who can add the label; Prodgate does not verify separation of duties or the reviewer's team membership.

## Protect sensitive plan data

Terraform plans can contain secrets in plaintext. Prodgate reads the plan locally and omits resource values from reports, but the plan file itself still needs protection.

- Do not commit `plan.json`.
- Do not print the full plan JSON to CI logs.
- Do not upload the raw plan as a public artifact.
- Remove the plan after the check, as shown above.

## Coverage

Prodgate currently supports Terraform and OpenTofu plan JSON with AWS-focused coverage:

- stateful resources and data-loss risk;
- database public access;
- S3 public-access protection;
- security-group ingress;
- IAM wildcards;
- deletion protection;
- agent-authored change signals.

Run these commands to inspect the current knowledge base:

```bash
prodgate coverage
prodgate coverage --json
prodgate explain <rule-id>
prodgate doctor plan.json
```

GCP, Azure, Pulumi, CDK and CloudFormation are not supported yet.

## Documentation

- [Configuration](docs/configuration.md)
- [Action inputs and outputs](docs/action.md)
- [CLI usage](docs/cli.md)
- [Coverage and rules](docs/coverage.md)
- [JSON envelope and integration fields](docs/json-envelope.md)
- [Sensitive plan data](docs/sensitive-plans.md)
- [Threat model](docs/threat-model.md)
- [Reporting and sanitized diagnostics](docs/reporting.md)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

Resource coverage is data-driven. Adding a resource type or rule should not require an engine rewrite. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and test instructions.

## License

MIT
