# Coverage and rules

Run `prodgate coverage --json` for the exact, current list. It is generated from the
rule tables, so it cannot drift from what Prodgate evaluates. This page explains the
shape of that coverage and its limits.

## Surfaces

| Surface | Coverage |
|---------|----------|
| Terraform plan JSON | Supported, tested against real `terraform show -json` output |
| OpenTofu plan JSON | Supported, tested against real `tofu show -json` output |
| AWS resources | Supported |
| GCP, Azure | Not supported yet |
| Pulumi, CDK, CloudFormation | Not supported |

Prodgate reasons about the change in the plan: create, update, delete, and replace. It
does not analyze resources that are unchanged.

## Critical by default

These fail the check in enforce mode.

- Deleting or replacing a resource that holds data. Databases, volumes, buckets, DNS
  zones, KMS keys, secrets, and log groups are covered. This is critical in any
  environment, because whether the data can be recovered depends on backups, snapshots,
  or versioning that the plan does not show.
- Deleting or replacing a resource classified as production.
- Turning off deletion protection.
- Making a database publicly accessible, on update or create.
- Weakening an S3 public access block.
- Opening a sensitive port to `0.0.0.0/0` or `::/0`, on update or create. Sensitive
  ports include SSH, RDP, and database ports.

## Warning by default

These are reported and do not block. They block with `--fail-on warning`.

- Deleting or replacing a data-holding resource that carries an explicit
  non-production environment tag and is not otherwise protected. An untagged or
  production-looking resource stays critical. A resource with deletion protection on
  stays critical regardless of tags.
- Deleting or replacing a resource that is neither data-holding nor production.
- Opening a non-sensitive port to the world.
- Granting a wildcard IAM action or resource.
- A security-critical value that is computed and unknown at plan time. Prodgate cannot
  confirm the resulting state, so it asks for review instead of assuming it is safe.
  This covers deletion protection, database public access, the S3 public access block,
  security-group ingress, and IAM policy.

## Availability notes

Replacing or removing a compute or network member interrupts service even when no data
is lost. Prodgate reports this as a note in the plan summary. It never produces a
finding and never changes the verdict. Aurora and DocumentDB cluster instances are
treated this way, because removing one affects capacity while the cluster keeps the
data.

## How environment classification works

Prodgate reads these tag keys, case-insensitively: `Environment`, `Env`, `Stage`,
`Tier`. A production value is `prod`, `production`, `prd`, or `live`, optionally with a
separator-delimited suffix such as `prod-us-east-1`.

A `Name` tag that clearly reads as production also escalates. It never downgrades.

Non-production values are `dev`, `develop`, `development`, `test`, `testing`, `qa`,
`uat`, `preview`, `sandbox`, `sbx`, `ephemeral`, `staging`, and `stage`.

Absence of a tag is not non-production. Unknown fails closed at critical. When the
signals conflict, for example a non-production tag on a production-looking address,
Prodgate fails closed and says why.

## What Prodgate does not detect

Coverage is deliberately narrow and high-signal. Prodgate does not comprehensively
detect:

- S3 bucket-policy or ACL exposure;
- service-scoped IAM wildcards such as `s3:*`;
- every data-holding AWS resource type;
- every public-access attribute across every AWS service;
- anything outside the plan, including live drift and applied state.

## Extending coverage

Coverage is a data table in `src/resources.ts`. Adding a resource type or a rule is an
edit to a table, not engine work. See [../CONTRIBUTING.md](../CONTRIBUTING.md).

## How Prodgate compares

Prodgate is narrower than a policy platform on purpose. It does not replace OPA,
Sentinel, Checkov, Atlantis, or Terraform Cloud, and it does not pretend they do not
exist.

- Use a policy engine when you want full control and you are willing to write and
  maintain policy.
- Use Prodgate when you want a working gate for destructive and exposing changes with
  no policy to write.
