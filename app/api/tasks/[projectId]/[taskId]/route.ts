import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { resolveLifecycleReasons } from '@/lib/taskLifecycle'

type Params = { params: Promise<{ projectId: string; taskId: string }> }

// GET /api/tasks/[projectId]/[taskId] — task detail + lifecycle events
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId, taskId } = await params

  const proj = await pool.query(
    'SELECT id, time_granularity FROM projects WHERE id = $1 AND user_id = $2',
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
       WHERE l.task_id = $1 AND l.project_id = $2
       ORDER BY l.created_at DESC`,
      [taskId, projectId]
    ),
  ])

  if (!taskRes.rows.length)
    return NextResponse.json(failure('Task not found', 404), { status: 404 })

  // 只取版本差异及任务身份，不向客户端返回完整快照。
  const versions = lifecycleRes.rows.some(event => !event.reason)
    ? await pool.query(
      `SELECT v.created_at, v.created_by, v.changes,
              EXISTS (SELECT 1 FROM jsonb_array_elements(v.snapshot->'tasks') t
                      WHERE t->>'id' = $2) AS task_matches
       FROM project_versions v
       WHERE v.project_id = $1 AND COALESCE(v.is_autosave, false) = false
       ORDER BY v.created_at ASC`,
      [projectId, taskId],
    )
    : { rows: [] }

  return NextResponse.json(success({
    task: taskRes.rows[0],
    lifecycle: resolveLifecycleReasons(lifecycleRes.rows, versions.rows, proj.rows[0].time_granularity === 'minute'),
  }))
}
