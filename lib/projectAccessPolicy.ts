import type { JwtPayload } from './auth'

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// All callers alias projects as p. Creator metadata does not grant permanent access:
// administrators can revoke even the creator's membership.
export function projectAccessSql(auth: JwtPayload, parameter = 1): { sql: string; values: string[] } {
  if (auth.shareProjectId) {
    return { sql: `p.id = $${parameter}::uuid`, values: [auth.shareProjectId] }
  }
  if (auth.role === 'administrator') return { sql: 'TRUE', values: [] }
  return {
    sql: `EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $${parameter}::uuid)`,
    values: [auth.userId],
  }
}
