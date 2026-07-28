/**
 * resources.ts
 *
 * The zero-config knowledge base. This file is DATA, not logic: adding coverage is
 * editing these tables, not writing code. It is the extensible, compounding asset
 * (the "boring breadth" moat) and it is what lets Prodgate "know what prod is" with
 * no configuration.
 *
 * Two tables:
 *   STATEFUL_RESOURCES   resource types whose deletion/replacement causes data loss
 *   DANGEROUS_MUTATIONS  declarative before/after rules for risky in-place updates
 *
 * AWS-first for v1. Other providers are added by extending these tables.
 */

// The named version of the built-in rule set. Bump it when the tables below change
// in a way that alters verdicts, so a policy digest identifies the exact rules.
export const POLICY_VERSION = 'aws-default-v1'

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export type StatefulInfo = { category: string; defaultSeverity: 'CRITICAL'; rationale: string }

// Deleting or replacing any of these can cause data loss regardless of environment
// tags. Whether recovery is possible depends on backups, snapshots, or versioning
// that the plan cannot see, so these are critical by default. Each entry records why.
export const STATEFUL_RESOURCES: Record<string, StatefulInfo> = {
  aws_db_instance: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the instance holds the database storage' },
  aws_rds_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the cluster owns the storage volume for the database' },
  aws_docdb_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the cluster holds the document storage' },
  aws_neptune_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the cluster holds the graph storage' },
  aws_redshift_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the cluster holds the warehouse storage' },
  aws_elasticache_cluster: { category: 'cache', defaultSeverity: 'CRITICAL', rationale: 'the node group holds in-memory data' },
  aws_elasticache_replication_group: { category: 'cache', defaultSeverity: 'CRITICAL', rationale: 'the replication group holds in-memory data' },
  aws_dynamodb_table: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the table holds its items' },
  aws_timestreamwrite_database: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the database holds its tables and time-series data' },
  aws_timestreamwrite_table: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the table holds its time-series records' },
  aws_qldb_ledger: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'the ledger holds its journal and tables' },
  aws_s3_bucket: { category: 'object-store', defaultSeverity: 'CRITICAL', rationale: 'the bucket holds its objects' },
  aws_ebs_volume: { category: 'volume', defaultSeverity: 'CRITICAL', rationale: 'the volume holds block data' },
  aws_efs_file_system: { category: 'filesystem', defaultSeverity: 'CRITICAL', rationale: 'the file system holds its files' },
  aws_fsx_lustre_file_system: { category: 'filesystem', defaultSeverity: 'CRITICAL', rationale: 'the file system holds its data' },
  aws_glacier_vault: { category: 'archive', defaultSeverity: 'CRITICAL', rationale: 'the vault holds its archives' },
  aws_route53_zone: { category: 'dns', defaultSeverity: 'CRITICAL', rationale: 'the zone holds its DNS records and removing it can break resolution for the domain' },
  aws_kms_key: { category: 'kms', defaultSeverity: 'CRITICAL', rationale: 'data encrypted under this key depends on it remaining available' },
  aws_secretsmanager_secret: { category: 'secret', defaultSeverity: 'CRITICAL', rationale: 'the secret holds its stored material' },
  aws_cloudwatch_log_group: { category: 'logs', defaultSeverity: 'CRITICAL', rationale: 'the log group holds retained log data' },
  aws_ecr_repository: { category: 'registry', defaultSeverity: 'CRITICAL', rationale: 'the repository holds its container images' },
}

export type DisruptiveInfo = { category: string }

// Replacing any of these interrupts service while the resource is torn down and
// recreated, even when no data is lost. Used only to add an informational note to
// the change digest; it never produces a finding or affects the verdict. Stateful
// types are deliberately absent: their replace is already CRITICAL for data loss,
// so a disruption note there would be redundant.
export const DISRUPTIVE_REPLACE: Record<string, DisruptiveInfo> = {
  // Aurora and DocumentDB separate storage from compute: a cluster instance is a
  // compute member, and removing or replacing it affects availability or capacity
  // while the cluster keeps the data. It is not a data-loss event, so it belongs
  // here rather than in the stateful table.
  aws_rds_cluster_instance: { category: 'database-compute' },
  aws_docdb_cluster_instance: { category: 'database-compute' },
  // Deleting the global cluster changes replication and failover topology; it does
  // not itself destroy the member clusters' storage (members are detached first).
  aws_rds_global_cluster: { category: 'database-topology' },
  aws_instance: { category: 'compute' },
  aws_lb: { category: 'load-balancer' },
  aws_alb: { category: 'load-balancer' },
  aws_elb: { category: 'load-balancer' },
  aws_lb_listener: { category: 'load-balancer' },
  aws_ecs_service: { category: 'service' },
  aws_eip: { category: 'network' },
  aws_nat_gateway: { category: 'network' },
  aws_cloudfront_distribution: { category: 'cdn' },
}

export type MutationMatch = { severity: Severity; summary: string; attribute: string }

export type DangerousRule = {
  id: string
  appliesTo: (type: string) => boolean
  evaluate: (before: any, after: any, afterUnknown: any) => MutationMatch | null
}

// ---- helpers for the security-group rules ----

const SENSITIVE_PORTS = [22, 3389, 3306, 5432, 6379, 27017, 9200, 5601, 5984, 11211, 1433, 5439, 2375, 2376, 9300]

function ingressList(v: any): any[] {
  if (!v || typeof v !== 'object') return []
  if (Array.isArray(v.ingress)) return v.ingress
  // Single-rule resources (aws_security_group_rule, aws_vpc_security_group_ingress_rule).
  // aws_security_group_rule carries a `type`; only ingress is in scope. An egress rule
  // to 0.0.0.0/0 is normal outbound access and must never be flagged as an opening.
  if (v.type !== undefined) return v.type === 'ingress' ? [v] : []
  if (
    v.cidr_ipv4 !== undefined ||
    v.cidr_blocks !== undefined ||
    v.cidr_ipv6 !== undefined ||
    v.ipv6_cidr_blocks !== undefined
  )
    return [v]
  return []
}
function isWorldOpen(ing: any): boolean {
  const v4 = (Array.isArray(ing?.cidr_blocks) && ing.cidr_blocks.includes('0.0.0.0/0')) || ing?.cidr_ipv4 === '0.0.0.0/0'
  const v6 = (Array.isArray(ing?.ipv6_cidr_blocks) && ing.ipv6_cidr_blocks.includes('::/0')) || ing?.cidr_ipv6 === '::/0'
  return v4 || v6
}
function portRange(ing: any): { from: number; to: number } {
  // protocol "-1"/"all" means every protocol and every port in AWS, regardless of
  // the from/to fields (which are commonly 0/0 in that case). aws_vpc_security_group_*
  // rules spell the field ip_protocol.
  const proto = String(ing?.protocol ?? ing?.ip_protocol ?? '').toLowerCase()
  if (proto === '-1' || proto === 'all') return { from: 0, to: 65535 }
  const from = Number(ing?.from_port ?? 0)
  const to = Number(ing?.to_port ?? 65535)
  return { from: isNaN(from) ? 0 : from, to: isNaN(to) ? 65535 : to }
}
function openWorldRanges(v: any): { from: number; to: number }[] {
  return ingressList(v).filter(isWorldOpen).map(portRange)
}
function coversSensitive(r: { from: number; to: number }): boolean {
  return SENSITIVE_PORTS.some(p => p >= r.from && p <= r.to) || (r.from === 0 && r.to >= 65535)
}

function iamHasWildcard(policy: any): boolean {
  if (!policy) return false
  let doc: any
  try {
    doc = typeof policy === 'string' ? JSON.parse(policy) : policy
  } catch {
    return false
  }
  const stmts = Array.isArray(doc?.Statement) ? doc.Statement : [doc?.Statement].filter(Boolean)
  const hasStar = (x: any) => x === '*' || (Array.isArray(x) && x.includes('*'))
  for (const s of stmts) {
    if (s?.Effect && s.Effect !== 'Allow') continue
    if (hasStar(s?.Action) || hasStar(s?.Resource)) return true
  }
  return false
}

// ---- shared unknown-value handling ----

// afterUnknown mirrors after with `true` where a value is computed and not known at
// plan time. An unknown can sit at the root of an attribute (`ingress: true`) or
// nested inside a collection (`ingress: [{ cidr_blocks: [true] }]`), so detection
// walks the attribute's subtree rather than only checking the root value.
function hasUnknownWithin(node: any): boolean {
  if (node === true) return true
  if (Array.isArray(node)) return node.some(hasUnknownWithin)
  if (node && typeof node === 'object') return Object.values(node).some(hasUnknownWithin)
  return false
}
// Scoped to the named attributes so an unknown value elsewhere in the plan (an ARN,
// a timestamp) never trips a security rule.
function anyUnknown(afterUnknown: any, attrs: string[]): boolean {
  if (!afterUnknown || typeof afterUnknown !== 'object') return false
  return attrs.some(a => hasUnknownWithin(afterUnknown[a]))
}

// Security-group world-openness is decided by CIDR values, so only an unknown CIDR
// (top-level for single-rule resources, or nested in an ingress rule) is
// indeterminate. An unknown description or other field inside ingress is not.
const SG_CIDR_KEYS = ['cidr_blocks', 'cidr_ipv4', 'ipv6_cidr_blocks', 'cidr_ipv6']
function ingressCidrUnknown(afterUnknown: any): boolean {
  if (!afterUnknown || typeof afterUnknown !== 'object') return false
  if (SG_CIDR_KEYS.some(k => hasUnknownWithin(afterUnknown[k]))) return true
  const ing = afterUnknown.ingress
  if (ing === true) return true
  if (Array.isArray(ing)) {
    return ing.some(r => r && typeof r === 'object' && SG_CIDR_KEYS.some(k => hasUnknownWithin(r[k])))
  }
  return false
}
function indeterminate(attribute: string, what: string): MutationMatch {
  return {
    severity: 'WARNING',
    summary: `resulting ${what} is unknown at plan time; cannot confirm it is safe (needs review)`,
    attribute,
  }
}

// ---- the rules ----

export const DANGEROUS_MUTATIONS: DangerousRule[] = [
  {
    id: 'deletion-protection-disabled',
    appliesTo: () => true,
    evaluate: (b, a, au) => {
      if (!b) return null
      const wasOn = b.deletion_protection === true || b.deletion_protection_enabled === true
      if (!wasOn) return null
      const nowOff = !!a && (a.deletion_protection === false || a.deletion_protection_enabled === false)
      if (nowOff) return { severity: 'CRITICAL', summary: 'disables deletion protection', attribute: 'deletion_protection' }
      if (anyUnknown(au, ['deletion_protection', 'deletion_protection_enabled'])) return indeterminate('deletion_protection', 'deletion protection')
      return null
    },
  },
  {
    id: 'database-made-public',
    appliesTo: (t) => t === 'aws_db_instance' || t === 'aws_rds_cluster' || t === 'aws_rds_cluster_instance',
    // Dangerous whenever the resulting state is public and it was not already:
    // fires on an update (false -> true) and on a create (no prior state). When the
    // resulting value is computed and unknown at plan time, we cannot confirm the
    // database stays private, so flag it for review rather than assume it is safe.
    evaluate: (b, a, au) => {
      if (a && a.publicly_accessible === true && b?.publicly_accessible !== true) {
        return { severity: 'CRITICAL', summary: 'makes a database publicly accessible', attribute: 'publicly_accessible' }
      }
      if (anyUnknown(au, ['publicly_accessible']) && b?.publicly_accessible !== true) {
        return indeterminate('publicly_accessible', 'database public access')
      }
      return null
    },
  },
  {
    id: 's3-public-access-block-weakened',
    appliesTo: (t) => t === 'aws_s3_bucket_public_access_block',
    evaluate: (b, a, au) => {
      const keys = ['block_public_acls', 'ignore_public_acls', 'block_public_policy', 'restrict_public_buckets']
      if (b) {
        // update: any protection flipped from on to off
        if (a && keys.some(k => b[k] === true && a[k] === false)) {
          return { severity: 'CRITICAL', summary: 'weakens the S3 public access block', attribute: 'public access block' }
        }
        // a protection that was on becomes unknown: cannot confirm it stays on
        if (anyUnknown(au, keys.filter(k => b[k] === true))) return indeterminate('public access block', 'S3 public access block')
        return null
      }
      if (!a) return null
      // create: flag an unambiguously wide-open block (every protection off), so a
      // partially-public static-site bucket does not cry wolf.
      if (keys.every(k => a[k] === false)) {
        return { severity: 'CRITICAL', summary: 'creates an S3 public access block with no protections', attribute: 'public access block' }
      }
      // if no protection is known on and at least one is unknown, we cannot rule out
      // that every protection ends up disabled.
      if (!keys.some(k => a[k] === true) && anyUnknown(au, keys)) {
        return indeterminate('public access block', 'S3 public access block')
      }
      return null
    },
  },
  {
    id: 'security-group-opened-to-world',
    appliesTo: (t) =>
      t === 'aws_security_group' || t === 'aws_security_group_rule' || t === 'aws_vpc_security_group_ingress_rule',
    evaluate: (b, a, au) => {
      const after = openWorldRanges(a)
      if (after.length > 0) {
        const before = openWorldRanges(b)
        const newly = after.filter(r => !before.some(q => q.from === r.from && q.to === r.to))
        if (newly.length > 0) {
          const sensitive = newly.some(coversSensitive)
          return {
            severity: sensitive ? 'CRITICAL' : 'WARNING',
            summary: sensitive ? 'opens a sensitive port to 0.0.0.0/0' : 'opens a security group to 0.0.0.0/0',
            attribute: 'ingress',
          }
        }
      }
      // an ingress CIDR is computed and unknown, and it was not already world-open: we
      // cannot confirm the resulting rules do not open it to the world.
      if (ingressCidrUnknown(au) && openWorldRanges(b).length === 0) {
        return indeterminate('ingress', 'security group ingress')
      }
      return null
    },
  },
  {
    id: 'iam-wildcard-added',
    appliesTo: (t) =>
      t === 'aws_iam_policy' ||
      t === 'aws_iam_role_policy' ||
      t === 'aws_iam_user_policy' ||
      t === 'aws_iam_group_policy',
    evaluate: (b, a, au) => {
      if (iamHasWildcard(a?.policy) && !iamHasWildcard(b?.policy)) {
        return { severity: 'WARNING', summary: 'grants a wildcard (*) IAM action or resource', attribute: 'policy' }
      }
      if (anyUnknown(au, ['policy']) && !iamHasWildcard(b?.policy)) return indeterminate('policy', 'IAM policy')
      return null
    },
  },
]
