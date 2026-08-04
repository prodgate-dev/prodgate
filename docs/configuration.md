# Configuration

Prodgate uses a built-in policy. You do not need a configuration file. Add
`prodgate.config.json` in the repository root only when you need exceptions, audit
mode, or a different failure threshold.

## Full example

```json
{
  "schemaVersion": 1,
  "mode": "enforce",
  "failOn": "critical",
  "ignore": ["module.sandbox.*"],
  "allowDestruction": ["aws_db_instance.scratch"]
}
```

## Options

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `schemaVersion` | `1` | `1` | The config format version. |
| `mode` | `audit`, `enforce` | `enforce` | `enforce` fails the check on a blocking finding. `audit` reports it without failing. |
| `failOn` | `critical`, `warning`, `never` | `critical` | The severity that blocks. `never` reports everything and blocks nothing. |
| `ignore` | array of address patterns | `[]` | Skips a resource completely. No findings of any kind are produced for it. |
| `allowDestruction` | array of address patterns | `[]` | Suppresses only the destruction finding for a resource. Exposure findings on the recreated resource are still reported. |

`allowDestroy` is accepted as a deprecated alias for `allowDestruction`.

Patterns match a resource address. Use `*` as a wildcard, for example
`module.sandbox.*`.

## Choose between ignore and allowDestruction

Use `allowDestruction` when a resource is meant to be destroyed but you still want to
know if it comes back exposed. A database that is replaced and returns publicly
accessible still produces a critical exposure finding.

Use `ignore` when you want no analysis at all. This is the broader and more dangerous
option.

## Command-line flags override the file

A flag wins over the file. The file wins over the defaults.

| Flag | Overrides |
|------|-----------|
| `--mode <audit\|enforce>` | `mode` |
| `--fail-on <critical\|warning\|never>` | `failOn` |
| `--config <file>` | The config path, which defaults to `prodgate.config.json` |

## Validation

Prodgate validates the file and does not silently ignore a mistake. Any of these exits
with code 2 and prints the reason:

- the file named with `--config` does not exist;
- the file is not valid JSON;
- the root is not an object;
- a key is unknown;
- `schemaVersion` is unsupported;
- `mode` or `failOn` is outside its allowed values;
- a pattern list is not an array of non-empty strings.

## Effective policy digest

Every report includes a policy digest. It is a SHA-256 of the effective policy: the
built-in rule set version, the resolved mode and threshold, and your normalized
exception lists. Two configurations that mean the same thing produce the same digest.
Reordering or duplicating a pattern does not change it. Changing behavior does.

Run `prodgate doctor` to confirm your config loads.
