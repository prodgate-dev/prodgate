# JSON evaluation envelope

`prodgate check --json` prints a single JSON object: the evaluation envelope. It is
a stable contract for integrations. It never contains raw or before/after plan
values, only the facts needed to act on a result.

On an input or configuration error the CLI prints `{ "error": { "code": "...",
"message": "...", "path"?: "..." } }` and exits 2 instead of an envelope.

## Compatibility

`schemaVersion` is `"MAJOR.MINOR"`. Within a major version, new optional fields may be
added and new enum values may appear; existing fields keep their meaning and are not
removed or repurposed. Consumers should ignore unknown fields. A breaking change
increments the major version.

## Top-level fields

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | string | `"1.0"`. |
| `engine` | object | `{ name: "prodgate", version }`. |
| `policy` | object | `{ version, digest }`, plus `configPath` when a config file was loaded. `digest` is a sha256 of the effective policy (rule-set version, mode, fail-on, and config), order-independent. |
| `plan` | object | `{ formatVersion?, terraformVersion?, hash }`. `hash` is a sha256 of the decoded, BOM-normalized plan text (UTF-16 input is decoded to text first). |
| `enforcement` | object | See below. |
| `stats` | object | See below. |
| `findings` | array | See below. Sorted, deterministic order. |
| `disruptions` | array | `{ address, type, action }` for compute or network members whose replace or removal affects availability. Informational; never affects the outcome. |
| `suppressions` | array | `{ address, matchedBy? }` for destructions an `allowDestruction` exception allowed through. |
| `source` | object | Present only under GitHub Actions. See below. |

## enforcement

| Field | Type | Notes |
|-------|------|-------|
| `mode` | enum | `audit` or `enforce`. |
| `failOn` | enum | `critical`, `warning`, or `never`. |
| `policyVerdict` | enum | `pass` or `fail`, from the findings and `failOn`, independent of mode. |
| `wouldBlock` | boolean | `true` when the findings cross the configured threshold, before mode or override is applied. It stays `true` on an overridden evaluation. |
| `executionOutcome` | enum | `allowed`, `blocked`, `reported` (audit saw a failure), or `overridden`. |
| `override` | object | Present only when an override was applied: `{ applied, mechanism, label?, workflowActor?, headSha? }`. `workflowActor` is the actor who triggered the run, not a verified approver. |

The exit code follows `executionOutcome`: `blocked` exits 1, everything else exits 0.
An input or config error exits 2 (no envelope).

## findings

Each finding: `{ ruleId, severity, category, confidence, type, resource: { address,
type }, action, reason, summary, evidence, agentAuthored }`, and an optional
`detail: { attribute? }` naming the attribute a dangerous-mutation rule keyed on.

- `ruleId` is stable and never reassigned to different semantics. `PG-DESTROY-*` for
  destructions, `PG-AWS-*` for dangerous mutations.
- `severity` is `CRITICAL`, `WARNING`, or `INFO`.
- `category` is `data_loss`, `recoverability`, `availability`, `exposure`,
  `privilege`, or `unknown`.
- `confidence` is `high`, `medium`, or `low`.
- `evidence` is an array of `{ field, observed }` naming the plan facts that produced
  the finding, using normalized tokens (for example `non_production`, `enabled`,
  `::/0`), never raw or sensitive values.
- Order is deterministic: severity (critical first), then `ruleId`, then resource
  address, then action. It does not depend on resource order in the plan.

## stats

`resourcesScanned`, and per-change-kind counts `created`, `updated`, `replaced`,
`destroyed` (a replace is counted as `replaced`, not as `destroyed`). `criticalCount`
and `warningCount` are severity counts. `destructive` and `dangerous` count findings,
not resources, and exclude suppressed or ignored resources.

## source (GitHub Actions only)

`{ repository?, commitSha?, workflowSha?, workflowRunId?, pullRequest? }`. `commitSha`
is the pull request head commit; `workflowSha` is included when it differs (the
synthetic merge commit on `pull_request` events).
