# Demo: an AI agent deletes the production database

An agent's "cleanup" PR removed `aws_db_instance.main` from `main.tf`. Terraform's
plan therefore schedules the production database for deletion. Prodgate blocks it.

`plan.json` here is the `terraform show -json` output of that change.

## Run it

```bash
prodgate check plan.json
```

Expected:

```
[CRITICAL] 1 destructive or dangerous change

  DELETE   aws_db_instance.main               deletes a stateful resource (data loss)

Verdict: FAIL
```

`prodgate check` exits non-zero, so in CI this fails the build.

## With agent detection

```bash
PRODGATE_COMMITS=$'cleanup unused resources\n\nCo-Authored-By: Claude <noreply@anthropic.com>' \
  prodgate check plan.json --github
```

The PR comment now flags the change as AI-agent generated, with the signal it matched.

## Overriding

In CI, adding the `prodgate-approved` label records a manual override. Locally:

```bash
prodgate check plan.json --override   # Verdict: PASS (override); the finding is still reported
```
