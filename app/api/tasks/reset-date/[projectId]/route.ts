import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })

  const { projectId } = await params

  // 验证项目所有权
  const owned = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, auth.value.userId]
  )
  if (owned.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }

  try {
    const body = await req.json()
    const { taskId, startDate } = body

    if (!taskId || !startDate) {
      return NextResponse.json(failure('taskId and startDate are required', 400), { status: 400 })
    }

    // 重置任务日期
    const result = await pool.query(
      `UPDATE tasks
       SET start_date = $1, updated_at = NOW()
       WHERE id = $2 AND project_id = $3 AND is_deleted = false
       RETURNING id, name, task_code, start_date, end_date, duration`,
      [startDate, taskId, projectId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(failure('Task not found', 404), { status: 404 })
    }

    return NextResponse.json(success({
      task: result.rows[0],
      message: '任务日期已重置，请刷新页面查看自动调整后的效果'
    }))
  } catch (err) {
    console.error('Error resetting task date:', err)
    return NextResponse.json(failure('Internal server error', 500), { status: 500 })
  }
}
