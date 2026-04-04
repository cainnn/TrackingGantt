import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

// GET /api/tasks/[projectId]/changelog?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=200
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const proj = auth.value.role === 'view'
    ? await pool.query('SELECT id FROM projects WHERE id = $1', [projectId])
    : await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (!proj.rows.length)
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const from = req.nextUrl.searchParams.get('from')
  const to = req.nextUrl.searchParams.get('to')
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 500), 1000)

  const conditions: string[] = ['l.project_id = $1']
  const values: unknown[] = [projectId]
  let idx = 2

  if (from) {
    conditions.push(`l.created_at >= $${idx}::date`)
    values.push(from)
    idx++
  }
  if (to) {
    conditions.push(`l.created_at < ($${idx}::date + interval '1 day')`)
    values.push(to)
    idx++
  }

  const res = await pool.query(
    `SELECT l.id, l.task_id, l.task_code, l.event_type, l.field_name,
            l.old_value, l.new_value, l.description,
            u.username AS created_by_name, l.created_at
     FROM task_lifecycle l
     LEFT JOIN users u ON u.id = l.created_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.created_at DESC
     LIMIT $${idx}`,
    [...values, limit],
  )

  // Also return a summary grouped by task
  const taskSummary: Record<string, {
    task_code: string
    changes: { field: string; old: string; new: string; at: string }[]
    created: boolean
    deleted: boolean
  }> = {}

  for (const row of res.rows) {
    if (!taskSummary[row.task_code]) {
      taskSummary[row.task_code] = { task_code: row.task_code, changes: [], created: false, deleted: false }
    }
    const entry = taskSummary[row.task_code]
    if (row.event_type === 'created') entry.created = true
    else if (row.event_type === 'deleted') entry.deleted = true
    else if (row.event_type === 'updated' && row.field_name) {
      entry.changes.push({
        field: row.field_name,
        old: row.old_value ?? '',
        new: row.new_value ?? '',
        at: row.created_at,
      })
    } else if (row.event_type === 'moved' && row.field_name) {
      entry.changes.push({
        field: row.field_name,
        old: row.old_value ?? '',
        new: row.new_value ?? '',
        at: row.created_at,
      })
    }
  }

  return NextResponse.json(success({
    events: res.rows,
    summary: taskSummary,
    total: res.rows.length,
  }))
}
