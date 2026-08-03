/**
 * plan.ts
 *
 * Parses a Terraform/OpenTofu plan in JSON form (`terraform show -json plan.tfplan`)
 * into a flat list of resource changes. Prodgate reads this resolved plan; it never
 * runs terraform, so it never needs backend, state, or cloud credentials.
 *
 * The plan's `resource_changes[].change.actions` array is the authoritative outcome:
 *   ["no-op"] | ["create"] | ["read"] | ["update"] | ["delete"]
 *   ["delete","create"] or ["create","delete"]  -> a replace (destroy + recreate)
 */

export type TfAction = 'no-op' | 'create' | 'read' | 'update' | 'delete'
export type ChangeKind = 'create' | 'update' | 'delete' | 'replace' | 'noop' | 'read'

export type ResourceChange = {
  address: string
  type: string
  name: string
  provider: string
  actions: TfAction[]
  before: any
  after: any
  // Terraform's after_unknown mirrors after with `true` where a value is computed
  // and not known at plan time. A rule that depends on such a field cannot assert
  // the resulting state is safe.
  afterUnknown: any
  changeKind: ChangeKind
  // Tags are kept per side. A replace destroys the object described by `before`
  // and creates the one described by `after`, and those can carry different
  // environment tags, so destruction is judged from beforeTags and the resulting
  // state from afterTags. Merging them would let a re-tag hide a destruction.
  beforeTags: Record<string, string>
  afterTags: Record<string, string>
}

function deriveChangeKind(actions: TfAction[]): ChangeKind {
  if (actions.includes('delete') && actions.includes('create')) return 'replace'
  if (actions.includes('delete')) return 'delete'
  if (actions.includes('update')) return 'update'
  if (actions.includes('create')) return 'create'
  if (actions.includes('read')) return 'read'
  return 'noop'
}

function extractTagsFrom(src: any): Record<string, string> {
  const raw = src?.tags_all ?? src?.tags ?? {}
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) out[String(k)] = String(v)
    }
  }
  return out
}

export type PlanInputErrorCode =
  | 'INVALID_JSON'
  | 'UNRECOGNIZED_DOCUMENT'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_RESOURCE_CHANGE'
  | 'UNSUPPORTED_ACTION'
  | 'PLAN_ERRORED'

// Thrown when the input is not a recognizable Terraform plan. The gate must fail
// closed on this rather than treat an unrecognized document as a plan with no
// changes, which would print PASS for a broken upstream step.
export class PlanInputError extends Error {
  code: PlanInputErrorCode
  path?: string
  constructor(code: PlanInputErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'PlanInputError'
    this.code = code
    this.path = path
  }
}

// The exact action sequences Terraform emits. Anything else (an unknown verb, an
// impossible combination like create+update, or an empty array) is rejected rather
// than guessed at.
// Action sequences Terraform emits, split by resource mode. A managed resource is
// never read, and a data source is only read (or unchanged), so pairing the two
// catches documents that are shaped like a plan but cannot have come from one.
const MANAGED_ACTION_SEQUENCES = new Set<string>([
  'no-op', 'create', 'update', 'delete', 'delete,create', 'create,delete',
])
const DATA_ACTION_SEQUENCES = new Set<string>(['read', 'no-op'])
const SUPPORTED_FORMAT_MAJORS = new Set<string>(['0', '1'])

// Enough structural validation to prove the intended artifact reached the gate,
// without reproducing Terraform's whole schema. Distinguishes a valid plan (with or
// without changes) from state files, truncated output, and unrelated JSON.
function validatePlanDoc(doc: any): void {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'Input is not a Terraform plan. Provide the output of `terraform show -json <planfile>`.')
  }
  if (doc.terraform_version != null && typeof doc.terraform_version !== 'string') {
    throw new PlanInputError('UNSUPPORTED_FORMAT', '`terraform_version` must be a string.')
  }
  // Every plan Terraform emits carries format_version. Requiring it keeps a JSON
  // document that merely looks plan-shaped from being evaluated as one.
  if (typeof doc.format_version !== 'string' || doc.format_version.length === 0) {
    throw new PlanInputError('UNSUPPORTED_FORMAT', 'Missing `format_version`. Provide the output of `terraform show -json <planfile>`.')
  }
  const major = doc.format_version.split('.')[0]
  if (!SUPPORTED_FORMAT_MAJORS.has(major)) {
    throw new PlanInputError('UNSUPPORTED_FORMAT', `Unsupported plan format_version "${doc.format_version}". Prodgate supports format 0.x and 1.x.`)
  }
  // A plan that failed to generate cannot be applied, so it must never be evaluated
  // as though it were a clean no-change plan.
  if ('errored' in doc) {
    if (typeof doc.errored !== 'boolean') {
      throw new PlanInputError('UNSUPPORTED_FORMAT', '`errored` must be a boolean.')
    }
    if (doc.errored === true) {
      throw new PlanInputError('PLAN_ERRORED', 'This plan reports `errored: true`, so planning failed and it cannot be applied. Fix the plan and regenerate it.')
    }
  }
  // Every recognized top-level section is type-checked when present, so a malformed
  // section can never serve as the evidence that this document is a plan. A present
  // section must have its expected type; null is not an accepted stand-in.
  const OBJECT_SECTIONS = ['configuration', 'planned_values', 'prior_state', 'variables', 'output_changes']
  // The checks representation is a list of check results, not an object.
  const ARRAY_SECTIONS = ['resource_drift', 'relevant_attributes', 'checks']
  for (const key of OBJECT_SECTIONS) {
    if (key in doc && !isPlainObject(doc[key])) {
      throw new PlanInputError('UNSUPPORTED_FORMAT', `\`${key}\` must be an object.`)
    }
  }
  for (const key of ARRAY_SECTIONS) {
    if (key in doc && !Array.isArray(doc[key])) {
      throw new PlanInputError('UNSUPPORTED_FORMAT', `\`${key}\` must be an array.`)
    }
  }

  const hasResourceChanges = 'resource_changes' in doc
  // A section only counts as evidence when it is present and well formed.
  const hasSection = (key: string) => key in doc && isPlainObject(doc[key])
  const looksLikePlan = hasResourceChanges || hasSection('planned_values') || hasSection('configuration')
  if (!looksLikePlan) {
    if ('values' in doc || 'resources' in doc) {
      throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'This looks like Terraform state, not a plan. Provide `terraform show -json <planfile>`.')
    }
    throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'Not a recognizable Terraform plan (no `resource_changes`). Provide `terraform show -json <planfile>`.')
  }
  if (hasResourceChanges && !Array.isArray(doc.resource_changes)) {
    throw new PlanInputError('INVALID_RESOURCE_CHANGE', '`resource_changes` must be an array.')
  }
  // A plan with no resource_changes must still carry the structure a real no-change
  // plan has, so a bare document cannot pass as "nothing to do".
  if (!hasResourceChanges && !(hasSection('planned_values') && hasSection('configuration'))) {
    throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'A plan without `resource_changes` must still include `planned_values` and `configuration`. Provide `terraform show -json <planfile>`.')
  }
}

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export type ParsedPlan = {
  changes: ResourceChange[]
  formatVersion?: string
  terraformVersion?: string
}

// Parses and validates the plan once, returning the changes plus the plan metadata
// the evaluation envelope needs. parsePlan wraps this for callers that only want the
// changes.
export function parsePlan(json: string): ResourceChange[] {
  return parsePlanFull(json).changes
}

export function parsePlanFull(json: string): ParsedPlan {
  let doc: any
  try {
    // Strip a leading byte-order mark. Windows tooling (PowerShell redirects,
    // some editors) prepends a BOM to `terraform show -json` output, which
    // otherwise makes JSON.parse throw on an otherwise valid plan.
    const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json
    doc = JSON.parse(text)
  } catch (e) {
    // The parser's message can quote the offending input, and a malformed plan may
    // hold a password or token near the failure, so report only a position.
    const pos = /position (\d+)/.exec((e as Error).message)?.[1]
    const where = pos ? ` (at character ${pos})` : ''
    throw new PlanInputError('INVALID_JSON', `Could not parse plan JSON${where}. Confirm that the file was produced by \`terraform show -json\`.`)
  }

  validatePlanDoc(doc)

  const changes = Array.isArray(doc.resource_changes) ? doc.resource_changes : []
  const out: ResourceChange[] = []

  for (let i = 0; i < changes.length; i++) {
    const rc = changes[i]
    const at = `resource_changes[${i}]`
    if (rc === null || typeof rc !== 'object' || Array.isArray(rc)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Resource change is not an object.', at)
    }

    // Every entry is validated structurally, including data sources, before data
    // sources are excluded from classification. A malformed data source is still a
    // malformed plan.
    const change = rc.change
    if (change === null || typeof change !== 'object' || Array.isArray(change)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing or invalid `change` object.', at + '.change')
    }
    if (!Array.isArray(change.actions)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing or invalid `change.actions` array.', at + '.change.actions')
    }
    // Identity is required so a change can never classify as an unnamed resource.
    if (typeof rc.address !== 'string' || rc.address.length === 0) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing `address`.', at + '.address')
    }
    if (typeof rc.type !== 'string' || rc.type.length === 0) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing `type`.', at + '.type')
    }
    if (typeof rc.name !== 'string' || rc.name.length === 0) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing `name`.', at + '.name')
    }
    // mode is required and has exactly two valid values. An unknown mode must not be
    // silently skipped, or a malformed entry would quietly disappear from the gate.
    if (rc.mode !== 'managed' && rc.mode !== 'data') {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing or invalid `mode` (expected "managed" or "data").', at + '.mode')
    }
    if (change.after_unknown !== undefined && change.after_unknown !== null && !isPlainObject(change.after_unknown)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', '`change.after_unknown` must be an object.', at + '.change.after_unknown')
    }
    // Actions are validated against the mode: a managed resource is never read, and a
    // data source is only read or unchanged.
    const sequence = change.actions.join(',')
    const allowed = rc.mode === 'managed' ? MANAGED_ACTION_SEQUENCES : DATA_ACTION_SEQUENCES
    if (!allowed.has(sequence)) {
      throw new PlanInputError('UNSUPPORTED_ACTION', `Unsupported action sequence [${change.actions.join(', ')}] for a ${rc.mode} resource.`, at + '.change.actions')
    }

    // Data sources are validated above but not classified. Their before/after shapes
    // are left unconstrained: a deferred read carries an object `after` while an
    // already-resolved one can carry nulls.
    if (rc.mode !== 'managed') continue

    const actions = change.actions as TfAction[]
    // A managed change must carry exactly the states its action implies, so a create
    // with no resulting state, or a delete that still reports one, cannot pass as
    // evaluable.
    const kind = deriveChangeKind(actions)
    const wantBefore = kind === 'delete' || kind === 'update' || kind === 'replace' || kind === 'noop'
    const wantAfter = kind === 'create' || kind === 'update' || kind === 'replace' || kind === 'noop'
    if (wantBefore && !isPlainObject(change.before)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', `A ${kind} requires a \`change.before\` object.`, at + '.change.before')
    }
    if (!wantBefore && change.before != null) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', `A ${kind} must not carry a \`change.before\` state.`, at + '.change.before')
    }
    if (wantAfter && !isPlainObject(change.after)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', `A ${kind} requires a \`change.after\` object.`, at + '.change.after')
    }
    if (!wantAfter && change.after != null) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', `A ${kind} must not carry a \`change.after\` state.`, at + '.change.after')
    }

    out.push({
      address: rc.address,
      type: rc.type,
      name: rc.name,
      provider: rc.provider_name ?? '',
      actions,
      before: change.before ?? null,
      after: change.after ?? null,
      afterUnknown: change.after_unknown ?? null,
      changeKind: deriveChangeKind(actions),
      beforeTags: extractTagsFrom(change.before),
      afterTags: extractTagsFrom(change.after),
    })
  }

  return {
    changes: out,
    formatVersion: typeof doc.format_version === 'string' ? doc.format_version : undefined,
    terraformVersion: typeof doc.terraform_version === 'string' ? doc.terraform_version : undefined,
  }
}
