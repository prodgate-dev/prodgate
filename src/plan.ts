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
  tags: Record<string, string>
}

function deriveChangeKind(actions: TfAction[]): ChangeKind {
  if (actions.includes('delete') && actions.includes('create')) return 'replace'
  if (actions.includes('delete')) return 'delete'
  if (actions.includes('update')) return 'update'
  if (actions.includes('create')) return 'create'
  if (actions.includes('read')) return 'read'
  return 'noop'
}

function extractTags(before: any, after: any): Record<string, string> {
  const src = after ?? before ?? {}
  const raw = src.tags_all ?? src.tags ?? {}
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) out[String(k)] = String(v)
    }
  }
  return out
}

export function parsePlan(json: string): ResourceChange[] {
  let doc: any
  try {
    doc = JSON.parse(json)
  } catch (e) {
    throw new Error('Could not parse plan JSON: ' + (e as Error).message)
  }

  const changes = Array.isArray(doc?.resource_changes) ? doc.resource_changes : []
  const out: ResourceChange[] = []

  for (const rc of changes) {
    // Skip data sources and anything that is not a managed resource.
    if (rc?.mode && rc.mode !== 'managed') continue

    const change = rc?.change ?? {}
    const actions: TfAction[] = Array.isArray(change.actions) ? change.actions : []

    out.push({
      address: rc?.address ?? `${rc?.type ?? '?'}.${rc?.name ?? '?'}`,
      type: rc?.type ?? '',
      name: rc?.name ?? '',
      provider: rc?.provider_name ?? '',
      actions,
      before: change.before ?? null,
      after: change.after ?? null,
      changeKind: deriveChangeKind(actions),
      tags: extractTags(change.before, change.after),
    })
  }

  return out
}
