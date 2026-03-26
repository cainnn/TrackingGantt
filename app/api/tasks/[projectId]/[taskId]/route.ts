import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string; taskId: string }> }

// GET /api/tasks/[projectId]/[taskId] — task detail + lifecycle events
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId, taskId } = await params

  const proj = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, auth.value.userId]
  )
  if (!proj.rows.length)
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const [taskRes, lifecycleRes] = await Promise.all([
    pool.query('SELECT * FROM tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]),
    pool.query(
      `SELECT l.*, u.username AS created_by_name
       FROM task_lifecycle l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.task_id = $1
       ORDER BY l.created_at DESC`,
      [taskId]
    ),
  ])

  if (!taskRes.rows.length)
    return NextResponse.json(failure('Task not found', 404), { status: 404 })

  return NextResponse.json(success({
    task: taskRes.rows[0],
    lifecycle: lifecycleRes.rows,
  }))
}
