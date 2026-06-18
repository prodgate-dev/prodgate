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

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export type StatefulInfo = { category: string }

// Deleting or replacing any of these destroys data irreversibly, regardless of
// environment tags. Data loss is data loss.
export const STATEFUL_RESOURCES: Record<string, StatefulInfo> = {
  aws_db_instance: { category: 'database' },
  aws_rds_cluster: { category: 'database' },
  aws_rds_cluster_instance: { category: 'database' },
  aws_rds_global_cluster: { category: 'database' },
  aws_docdb_cluster: { category: 'database' },
  aws_docdb_cluster_instance: { category: 'database' },
  aws_neptune_cluster: { category: 'database' },
  aws_redshift_cluster: { category: 'database' },
  aws_elasticache_cluster: { category: 'cache' },
  aws_elasticache_replication_group: { category: 'cache' },
  aws_dynamodb_table: { category: 'database' },
  aws_timestreamwrite_database: { category: 'database' },
  aws_timestreamwrite_table: { category: 'database' },
  aws_qldb_ledger: { category: 'database' },
  aws_s3_bucket: { category: 'object-store' },
  aws_ebs_volume: { category: 'volume' },
  aws_efs_file_system: { category: 'filesystem' },
  aws_fsx_lustre_file_system: { category: 'filesystem' },
  aws_glacier_vault: { category: 'archive' },
  aws_route53_zone: { category: 'dns' },
  aws_kms_key: { category: 'kms' },
  aws_secretsmanager_secret: { category: 'secret' },
  aws_cloudwatch_log_group: { category: 'logs' },
  aws_ecr_repository: { category: 'registry' },
}

export type MutationMatch = { severity: Severity; summary: string; attribute: string }

export type DangerousRule = {
  id: string
  appliesTo: (type: string) => boolean
  evaluate: (before: any, after: any) => MutationMatch | null
}

// ---- helpers for the security-group rules ----

const SENSITIVE_PORTS = [22, 3389, 3306, 5432, 6379, 27017, 9200, 5601, 5984, 11211, 1433, 5439, 2375, 2376, 9300]

function ingressList(v: any): any[] {
  if (!v || typeof v !== 'object') return []
  if (Array.isArray(v.ingress)) return v.ingress
  // single-rule resources (aws_security_group_rule, aws_vpc_security_group_ingress_rule)
  if (v.type === 'ingress' || v.cidr_ipv4 !== undefined || v.cidr_blocks !== undefined) return [v]
  return []
}
function isWorldOpen(ing: any): boolean {
  return (Array.isArray(ing?.cidr_blocks) && ing.cidr_blocks.includes('0.0.0.0/0')) || ing?.cidr_ipv4 === '0.0.0.0/0'
}
function portRange(ing: any): { from: number; to: number } {
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
    evaluate: (b, a) =>
      b && a && b.publicly_accessible === false && a.publicly_accessible === true
        ? { severity: 'CRITICAL', summary: 'makes a database publicly accessible', attribute: 'publicly_accessible' }
        : null,
  },
  {
    id: 's3-public-access-block-weakened',
    appliesTo: (t) => t === 'aws_s3_bucket_public_access_block',
    evaluate: (b, a) => {
      if (!b || !a) return null
      const keys = ['block_public_acls', 'ignore_public_acls', 'block_public_policy', 'restrict_public_buckets']
      return keys.some(k => b[k] === true && a[k] === false)
        ? { severity: 'CRITICAL', summary: 'weakens the S3 public access block', attribute: 'public access block' }
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
