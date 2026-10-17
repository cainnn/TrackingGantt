import pool from './db'
import type { JwtPayload } from './auth'
import { isUuid, projectAccessSql } from './projectAccessPolicy'

export async function getAccessibleProject(projectId: string, auth: JwtPayload) {
  if (!isUuid(projectId)) return { rows: [], rowCount: 0 }
  const access = projectAccessSql(auth, 2)
  return pool.query(`SELECT p.* FROM projects p WHERE p.id = $1 AND (${access.sql})`, [projectId, ...access.values])
}

export async function hasProjectAccess(projectId: string, auth: JwtPayload): Promise<boolean> {
  return (await getAccessibleProject(projectId, auth)).rows.length > 0
}
