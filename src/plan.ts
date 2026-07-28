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

const SUPPORTED_ACTIONS = new Set<string>(['no-op', 'create', 'read', 'update', 'delete'])

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
  const hasResourceChanges = 'resource_changes' in doc
  const looksLikePlan = hasResourceChanges || 'planned_values' in doc || 'configuration' in doc
  if (!looksLikePlan) {
    if ('values' in doc || 'resources' in doc) {
      throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'This looks like Terraform state, not a plan. Provide `terraform show -json <planfile>`.')
    }
    throw new PlanInputError('UNRECOGNIZED_DOCUMENT', 'Not a recognizable Terraform plan (no `resource_changes`). Provide `terraform show -json <planfile>`.')
  }
  if (hasResourceChanges && !Array.isArray(doc.resource_changes)) {
    throw new PlanInputError('INVALID_RESOURCE_CHANGE', '`resource_changes` must be an array.')
  }
}

export function parsePlan(json: string): ResourceChange[] {
  let doc: any
  try {
    // Strip a leading byte-order mark. Windows tooling (PowerShell redirects,
    // some editors) prepends a BOM to `terraform show -json` output, which
    // otherwise makes JSON.parse throw on an otherwise valid plan.
    const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json
    doc = JSON.parse(text)
  } catch (e) {
    throw new PlanInputError('INVALID_JSON', 'Could not parse plan JSON: ' + (e as Error).message)
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
    // Skip data sources and anything that is not a managed resource.
    if (rc.mode && rc.mode !== 'managed') continue

    const change = rc.change
    if (change === null || typeof change !== 'object' || Array.isArray(change)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing or invalid `change` object.', at + '.change')
    }
    if (!Array.isArray(change.actions)) {
      throw new PlanInputError('INVALID_RESOURCE_CHANGE', 'Missing or invalid `change.actions` array.', at + '.change.actions')
    }
    for (const a of change.actions) {
      if (!SUPPORTED_ACTIONS.has(a)) {
        throw new PlanInputError('UNSUPPORTED_ACTION', `Unsupported action "${a}".`, at + '.change.actions')
      }
    }
    const actions = change.actions as TfAction[]

    out.push({
      address: rc.address ?? `${rc.type ?? '?'}.${rc.name ?? '?'}`,
      type: rc.type ?? '',
      name: rc.name ?? '',
      provider: rc.provider_name ?? '',
      actions,
      before: change.before ?? null,
      after: change.after ?? null,
      changeKind: deriveChangeKind(actions),
      beforeTags: extractTagsFrom(change.before),
      afterTags: extractTagsFrom(change.after),
    })
  }

  return out
}
