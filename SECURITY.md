# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately. Do not open a public issue for a security
problem.

Use GitHub's private advisory form at
https://github.com/prodgate-dev/prodgate/security/advisories/new, or email
security@prodgate.dev.

Please include:

- what you found and where, with a rule ID or file path if you have one;
- how to reproduce it, using a sanitized plan or a minimal fixture;
- the Prodgate version and how you ran it (CLI or the GitHub Action).

Never attach a raw production plan. A Terraform plan can contain secrets in plaintext.
Run `prodgate diagnostics <plan>` and share that output, which omits resource values.

You can expect an acknowledgement within a few working days and a fix or a plan for one
once the report is confirmed.

## Scope

Prodgate reads a plan file locally. It does not run Terraform, does not read your state,
and never needs cloud credentials, so it cannot change anything in your cloud account.

The most relevant classes of report are:

- a way to make Prodgate pass a plan it should block, or block one it should pass;
- a way to make the tool leak plan contents into a report, a log, or the JSON output;
- a problem in the GitHub Action's handling of the token, the override label, or fork
  pull requests.

Prodgate is a CI-side check. It is not a defense against a pull-request author who is
deliberately subverting their own workflow. See
[docs/threat-model.md](docs/threat-model.md) for that boundary and how to harden the
gate with branch protection and CODEOWNERS.

## Supported versions

Fixes land on the latest 1.x release. Pin the Action to a released tag and keep it
current.
