# Changelog

All notable changes to Prodgate are recorded here. Versions follow semantic
versioning.

## 1.0.0 - 2026-08-09

First stable release.

Prodgate is now a CI gate for Terraform and OpenTofu plans. It reads a
`terraform show -json` plan locally, without running Terraform and without cloud
credentials, and blocks destructive or dangerous changes before they are applied.

Note on the version jump: the `prodgate` npm name previously held an unrelated project.
The 0.x versions are a different product and are deprecated. 1.0.0 is the first release
of the plan-checking tool described in this repository.

### Added

- Plan checker for destructive and dangerous AWS changes: stateful deletion and
  replacement, production-tagged destruction, database public access, S3 public-access
  weakening, world-open sensitive ports, IAM wildcards, and deletion-protection
  changes.
- Before/after evaluation, so a replacement can report both a destruction and a
  dangerous-recreation finding.
- Deterministic unknown-value handling: a security-critical value that is computed at
  plan time is reported for review rather than assumed safe.
- Fail-closed input validation. An invalid or unrecognized plan exits 2 and never
  passes.
- Enforce and audit modes, with a configurable failure threshold.
- GitHub Action with a pull-request comment, the `prodgate-approved` manual override,
  and machine-readable outputs. The override is bound to the event that added the label
  and is invalidated by a new commit.
- Zero-policy defaults, with an optional `prodgate.config.json` for exceptions, mode,
  and threshold. The effective policy is reported as a digest.
- Stable JSON evaluation envelope, rule IDs, and per-finding evidence that omits
  resource values.
- Commands: `check`, `coverage`, `explain`, `doctor`, and `diagnostics`.
- OpenTofu support, tested against real `tofu show -json` output.
