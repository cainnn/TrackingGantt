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
    // 批量更新所有任务的 auto_schedule 为 true
    const result = await pool.query(
      `UPDATE tasks
       SET auto_schedule = true, updated_at = NOW()
       WHERE project_id = $1 AND is_deleted = false
       RETURNING id, name, task_code, auto_schedule`,
      [projectId]
    )

    return NextResponse.json(success({
      updated: result.rows.length,
      tasks: result.rows
    }))
  } catch (err) {
    console.error('Error enabling auto_schedule:', err)
    return NextResponse.json(failure('Internal server error', 500), { status: 500 })
  }
}
