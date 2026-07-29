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

More goldens (replacement, computed/unknown from a real apply) should be added from
dogfooding runs against real state.
