import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

// GET /api/tasks/[projectId]/retrolog — 回溯修改审计日志
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const proj = auth.value.role === 'view'
    ? await pool.query('SELECT id FROM projects WHERE id = $1', [projectId])
    : await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (!proj.rows.length) return NextResponse.json(failure('Not found', 404), { status: 404 })

  const res = await pool.query(
    `SELECT l.id, l.task_id, t.task_code, t.name AS task_name,
            l.status_date_at_change, l.field, l.old_value, l.new_value, l.reason,
            l.changed_by, u.username AS changed_by_name, l.changed_at
     FROM task_change_log l
     LEFT JOIN tasks t ON t.id = l.task_id
     LEFT JOIN users u ON u.id = l.changed_by
     WHERE l.project_id = $1
     ORDER BY l.changed_at DESC
     LIMIT 1000`,
    [projectId],
  )
  return NextResponse.json(success(res.rows))
}
