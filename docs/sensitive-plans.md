# Sensitive plan data

A Terraform plan in JSON form can contain secrets in plaintext. Passwords, keys, and
tokens can appear even when the normal `terraform plan` output marks those values as
sensitive.

Treat `plan.json` as a secret.

## What Prodgate does

- It reads the plan from a local file.
- It does not run Terraform.
- It does not need cloud credentials.
- It does not upload the plan anywhere.
- Its reports and its JSON envelope omit resource values.
- Its parse errors do not quote the offending input, so a malformed plan cannot echo a
  secret into a log.

## What you must do

Delete the plan file after the check runs.

```yaml
      - name: Remove plan file
        if: always()
        run: rm -f plan.json plan.tfplan
```

Then:

- Add `plan.json` and `*.tfplan` to `.gitignore`. Do not commit a plan.
- Do not print the full plan JSON to a public CI log.
- Never upload a plan as a workflow artifact. Anyone with read access to the repository
  can download an artifact, and on a public repository it is publicly reachable for the
  whole retention period.
- Restrict access to any CI artifact that does contain a plan, and keep its retention
  short.

## No telemetry

Prodgate does not transmit plan contents, findings, repository metadata, or usage
analytics. It collects no telemetry. If a future feature ever sends anything, it will be
opt-in and separately documented.

The GitHub Action does call the GitHub API to post the pull-request comment and to read
or clear the override label, using the token you provide. That is the Action working
with your own repository, not Prodgate telemetry.

## Reporting a problem safely

Never attach a raw plan to an issue. Use `prodgate diagnostics`, which prints only rule
IDs, resource types, actions, and normalized evidence. See [reporting.md](reporting.md).
