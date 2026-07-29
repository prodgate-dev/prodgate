# Golden plans

These are real `terraform show -json` outputs, not handwritten fixtures, so the tests
run against the field shapes Terraform actually emits (`planned_values`,
`sensitive_values`, `after_unknown`, `before_sensitive`, `prior_state`,
`configuration`).

Generated with:
- Terraform 1.9.8
- hashicorp/aws provider ~> 5.0
- format_version 1.2

All credentials and passwords in these files are placeholders, never real secrets.

| File | What it is |
|------|------------|
| `create-exposures.tfplan.json` | Creates a publicly accessible RDS instance, a wide-open S3 public access block, and a security group open to `0.0.0.0/0` and `::/0` on port 22 |
| `destroy-prod-db.tfplan.json` | Destroys a production RDS instance |
| `no-change.tfplan.json` | A valid plan with no changes |
| `replace-public-db.tfplan.json` | Replaces a production RDS instance (a ForceNew change) so it comes back publicly accessible, producing both a destruction and a public-recreate finding |
| `unknown-sg-cidr.tfplan.json` | Creates a security group whose ingress CIDR is computed and unknown at plan time |

Sanitization: these were generated with placeholder credentials and no real
infrastructure, so they contain no real account IDs, ARNs, keys, or hostnames. A test
scans them for obvious secrets. An OpenTofu-generated plan should be added from a
dogfooding run.
