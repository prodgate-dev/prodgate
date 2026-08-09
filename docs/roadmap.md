# Roadmap

This states what Prodgate does today, what is being considered, and what is not
promised. It is a guide to intent, not a commitment to dates.

## Current (1.x)

Shipped and supported.

- Terraform and OpenTofu plan JSON, AWS resource coverage.
- Destructive and dangerous-change detection: stateful deletion and replacement,
  production-tagged destruction, database public access, S3 public-access weakening,
  world-open sensitive ports, IAM wildcards, deletion protection.
- Before/after evaluation and deterministic unknown-value handling.
- Enforce and audit modes with a configurable threshold.
- GitHub Action with a PR comment, the `prodgate-approved` manual override, and
  machine-readable outputs.
- Zero-policy defaults with optional exceptions, a stable JSON envelope, rule IDs, and
  a policy digest.
- `check`, `coverage`, `explain`, `doctor`, and `diagnostics`.

## Under evaluation

Being explored. Not committed, and not present today.

- Wider AWS coverage: more data-holding resource types and more public-access
  attributes.
- GCP and Azure plan support.
- Richer IAM analysis, including service-scoped wildcards such as `s3:*`.
- Organization-level policy defaults with per-repo exceptions.

## Not promised

Deliberately out of scope for now. Do not plan around these.

- A hosted dashboard or web application.
- Verified, plan-bound approvals that prove approver identity and separation of duties.
  The current label override is a recorded override, not a verified approval. See
  [threat-model.md](threat-model.md).
- Cross-repository analytics or an evidence store.
- SSO, RBAC, or notification integrations.
- Runtime protection. Prodgate reads a plan. It does not intercept shell commands,
  direct SQL, or application migrations.
- Support for Pulumi, CDK, or CloudFormation.

## How to influence it

Coverage is a data table, so adding a resource type or a rule is a small change. See
[../CONTRIBUTING.md](../CONTRIBUTING.md). Report a missed or wrong finding with
`prodgate diagnostics`, following [reporting.md](reporting.md).
