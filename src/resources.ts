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
  aws_db_instance: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Deleting the instance destroys its database storage unless a final snapshot is taken.' },
  aws_rds_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'The cluster owns the storage volume, so destroying it destroys the database data unless a final snapshot is taken.' },
  aws_rds_global_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Removing the global cluster tears down its regional storage.' },
  aws_docdb_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'The cluster holds the document storage, so destroying it destroys the data.' },
  aws_neptune_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'The cluster holds the graph storage, so destroying it destroys the data.' },
  aws_redshift_cluster: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'The cluster holds the warehouse storage, so destroying it destroys the data unless a final snapshot is taken.' },
  aws_elasticache_cluster: { category: 'cache', defaultSeverity: 'CRITICAL', rationale: 'Destroying the cache node group discards its in-memory data.' },
  aws_elasticache_replication_group: { category: 'cache', defaultSeverity: 'CRITICAL', rationale: 'Destroying the replication group discards its in-memory data.' },
  aws_dynamodb_table: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Deleting the table deletes all items unless point-in-time recovery is used to restore them.' },
  aws_timestreamwrite_database: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Deleting the database deletes its tables and time-series data.' },
  aws_timestreamwrite_table: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Deleting the table deletes its time-series records.' },
  aws_qldb_ledger: { category: 'database', defaultSeverity: 'CRITICAL', rationale: 'Deleting the ledger destroys its journal and tables.' },
  aws_s3_bucket: { category: 'object-store', defaultSeverity: 'CRITICAL', rationale: 'Deleting the bucket removes its objects unless versioning or replication preserved copies.' },
  aws_ebs_volume: { category: 'volume', defaultSeverity: 'CRITICAL', rationale: 'Deleting the volume destroys the block data on it unless a snapshot exists.' },
  aws_efs_file_system: { category: 'filesystem', defaultSeverity: 'CRITICAL', rationale: 'Deleting the file system destroys the files stored on it unless a backup exists.' },
  aws_fsx_lustre_file_system: { category: 'filesystem', defaultSeverity: 'CRITICAL', rationale: 'Deleting the file system destroys the data on it unless a backup exists.' },
  aws_glacier_vault: { category: 'archive', defaultSeverity: 'CRITICAL', rationale: 'Deleting the vault destroys the archives stored in it.' },
  aws_route53_zone: { category: 'dns', defaultSeverity: 'CRITICAL', rationale: 'Deleting the zone removes its DNS records and can break resolution for the domain.' },
  aws_kms_key: { category: 'kms', defaultSeverity: 'CRITICAL', rationale: 'Scheduling the key for deletion makes data encrypted under it unrecoverable.' },
  aws_secretsmanager_secret: { category: 'secret', defaultSeverity: 'CRITICAL', rationale: 'Deleting the secret removes the stored secret material.' },
  aws_cloudwatch_log_group: { category: 'logs', defaultSeverity: 'CRITICAL', rationale: 'Deleting the log group deletes its retained log data.' },
  aws_ecr_repository: { category: 'registry', defaultSeverity: 'CRITICAL', rationale: 'Deleting the repository deletes the container images stored in it.' },
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

// ---- the rules ----

export const DANGEROUS_MUTATIONS: DangerousRule[] = [
  {
    id: 'deletion-protection-disabled',
    appliesTo: () => true,
    evaluate: (b, a) => {
      if (!b || !a) return null
      const wasOn = b.deletion_protection === true || b.deletion_protection_enabled === true
      const nowOff = a.deletion_protection === false || a.deletion_protection_enabled === false
      return wasOn && nowOff
        ? { severity: 'CRITICAL', summary: 'disables deletion protection', attribute: 'deletion_protection' }
        : null
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
      if (au?.publicly_accessible === true && b?.publicly_accessible !== true) {
        return { severity: 'WARNING', summary: 'resulting publicly_accessible is unknown at plan time; cannot confirm the database stays private (needs review)', attribute: 'publicly_accessible' }
      }
      return null
    },
  },
  {
    id: 's3-public-access-block-weakened',
    appliesTo: (t) => t === 'aws_s3_bucket_public_access_block',
    evaluate: (b, a) => {
      if (!a) return null
      const keys = ['block_public_acls', 'ignore_public_acls', 'block_public_policy', 'restrict_public_buckets']
      if (b) {
        // update: any protection flipped from on to off
        return keys.some(k => b[k] === true && a[k] === false)
          ? { severity: 'CRITICAL', summary: 'weakens the S3 public access block', attribute: 'public access block' }
          : null
      }
      // create: only flag an unambiguously wide-open block (every protection off),
      // so a partially-public static-site bucket does not cry wolf.
      return keys.every(k => a[k] === false)
        ? { severity: 'CRITICAL', summary: 'creates an S3 public access block with no protections', attribute: 'public access block' }
        : null
    },
  },
  {
    id: 'security-group-opened-to-world',
    appliesTo: (t) =>
      t === 'aws_security_group' || t === 'aws_security_group_rule' || t === 'aws_vpc_security_group_ingress_rule',
    evaluate: (b, a) => {
      const after = openWorldRanges(a)
      if (after.length === 0) return null
      const before = openWorldRanges(b)
      const newly = after.filter(r => !before.some(q => q.from === r.from && q.to === r.to))
      if (newly.length === 0) return null
      const sensitive = newly.some(coversSensitive)
      return {
        severity: sensitive ? 'CRITICAL' : 'WARNING',
        summary: sensitive ? 'opens a sensitive port to 0.0.0.0/0' : 'opens a security group to 0.0.0.0/0',
        attribute: 'ingress',
      }
    },
  },
  {
    id: 'iam-wildcard-added',
    appliesTo: (t) =>
      t === 'aws_iam_policy' ||
      t === 'aws_iam_role_policy' ||
      t === 'aws_iam_user_policy' ||
      t === 'aws_iam_group_policy',
    evaluate: (b, a) =>
      iamHasWildcard(a?.policy) && !iamHasWildcard(b?.policy)
        ? { severity: 'WARNING', summary: 'grants a wildcard (*) IAM action or resource', attribute: 'policy' }
        : null,
  },
]
