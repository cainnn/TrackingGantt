import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { SaveBaseline } from '../clientSave'
import { comparablePlan } from '../planSaveVerification'
import { toDateTimeStr } from '../clientTime'

export const PLAN_REVISION_HEADER = 'x-gantt-plan-revision'
export class PlanSaveConflict extends Error {
  constructor() { super('后台计划已在其他窗口或被其他用户修改，本次保存已停止，未保存的修改仍保留；请核对最新计划后再提交') }
}

/** Caller holds the project write lock, or uses a repeatable-read transaction. */
export async function readPlanState(client: PoolClient, projectId: string): Promise<SaveBaseline & { revision: string }> {
  // One PostgreSQL client executes queries serially; keep the same transaction
  // snapshot without queueing simultaneous query calls on that connection.
  const tasks = await client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId])
  const dependencies = await client.query(`SELECT d.* FROM dependencies d JOIN tasks f ON f.id = d.from_task_id AND f.is_deleted = false
    JOIN tasks t ON t.id = d.to_task_id AND t.is_deleted = false WHERE d.project_id = $1`, [projectId])
  const project = await client.query('SELECT status_date, planning_status, custom_fields FROM projects WHERE id = $1', [projectId])
  const lines = await client.query('SELECT id, project_id, name, line_date, color, visible FROM project_lines WHERE project_id = $1 ORDER BY line_date', [projectId])
  const state: SaveBaseline = { tasks: tasks.rows, dependencies: dependencies.rows, lines: lines.rows,
    statusDate: toDateTimeStr(project.rows[0]?.status_date), planningStatus: project.rows[0]?.planning_status,
    customFields: project.rows[0]?.custom_fields ?? [] }
  const canonical = comparablePlan(state)
  // PostgreSQL JSON objects may have a different key order from submitted JSON.
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)])) : value
  return { ...state, revision: createHash('sha256').update(JSON.stringify(stable(canonical))).digest('hex') }
}

export async function lockAndCheckPlan(client: PoolClient, projectId: string, headers: Headers) {
  await client.query("SET LOCAL lock_timeout = '10s'")
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])
  const expected = headers.get(PLAN_REVISION_HEADER)
  if (expected && (await readPlanState(client, projectId)).revision !== expected) throw new PlanSaveConflict()
}

/** Return the new token before committing, while the same project lock is held. */
export async function planRevisionHeaders(client: PoolClient, projectId: string, headers: Headers): Promise<Record<string, string>> {
  if (!headers.has(PLAN_REVISION_HEADER)) return {}
  return { [PLAN_REVISION_HEADER]: (await readPlanState(client, projectId)).revision }
}
