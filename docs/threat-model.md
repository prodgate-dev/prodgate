# Threat model

Be clear about what a CI gate does and does not defend against.

## What Prodgate defends against

Prodgate catches mistakes and oversight. The routine destructive change buried in a
large diff. The AI agent that deletes the wrong resource. The change that quietly makes
a database public.

## What Prodgate does not defend against

Prodgate is not a defense against a pull-request author who is deliberately subverting
their own CI.

The pull-request branch controls both the workflow file and the step that produces
`plan.json`. An author can therefore feed Prodgate a benign plan, or remove the step
entirely. Every CI-side policy check shares this boundary, including OPA and Checkov.
Naming it is more honest than implying the gate is tamper-proof.

## Raise the gate toward an enforcement control

- Make the Prodgate check **required** in branch protection, so a pull request cannot
  merge without it.
- Put `.github/workflows/` under **CODEOWNERS**, so changing the workflow itself needs
  review.
- Generate `plan.json` in a trusted job from the merge result, not from
  author-controlled output.

## The override is not a verified approval

Adding the `prodgate-approved` label applies a repository-controlled manual override.
The finding stays reported and the gate passes.

The override is honored only in the run for the event that added the label. Re-running
that same run keeps the same event and the same head commit, so it stays valid. Opening,
reopening, or pushing a new commit is a different event, so a leftover label never
passes a plan on its own. After a new commit, remove and re-add the label.

Prodgate does not verify:

- that the actor is a human;
- that the actor is not the pull-request author;
- that the actor belongs to an authorized team;
- that the actor read the plan;
- that the plan later applied matches the plan that was evaluated.

GitHub repository permissions decide who can apply the label. The report and the JSON
envelope record the label, the triggering actor, and the plan head commit, so the
override is auditable. That is not the same as authorized.

Reserve the phrase "verified approval" for a control that proves approver identity and
separation of duties. Prodgate does not do that today.

## Trust boundary

Prodgate reads a plan JSON file. It does not run Terraform, does not read your state,
and never needs cloud credentials. It cannot change anything in your cloud account.

See [sensitive-plans.md](sensitive-plans.md) for how to handle the plan file itself, and
[action.md](action.md) for workflow permissions and fork behavior.
