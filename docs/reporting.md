# Reporting a wrong finding safely

Prodgate improves through reports of incorrect findings (false positives) and missed
dangerous changes (false negatives). The one rule for reporting: never share a raw
plan.

## Do not attach a raw plan

A Terraform plan in JSON form can contain plaintext secrets (passwords, keys, tokens)
even when the normal CLI output marks them as sensitive. Do not paste or attach a raw
`plan.json` to an issue. Share only the fields the issue form asks for, plus a
minimal, sanitized reproduction if you can make one.

## Making a minimal, sanitized reproduction

You rarely need the whole plan. Reduce it to the smallest `resource_changes` entry
that still shows the behavior:

1. Keep only the one resource change in question.
2. Remove every attribute the rule does not depend on. For most rules a handful of
   fields is enough (for example `actions`, `publicly_accessible`, or the `ingress`
   CIDR).
3. Replace real names, ARNs, IDs, account numbers, IP ranges, and tag values with
   placeholders. Keep only what matters to the rule (for example, that a CIDR is
   `0.0.0.0/0`, or that an environment tag classifies as production).
4. Confirm the reduced plan still reproduces the result with `prodgate check`.

The rule ID, resource type, action, and this minimal snippet are enough to fix most
issues without ever seeing your infrastructure.
