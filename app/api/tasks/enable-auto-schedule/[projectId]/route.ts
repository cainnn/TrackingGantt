import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock

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
    // 仅为有入依赖关系的任务启用自动排程（跳过没有依赖的手动任务）
    const result = await pool.query(
      `UPDATE tasks t
       SET auto_schedule = true, updated_at = NOW()
       WHERE t.project_id = $1 AND t.is_deleted = false AND t.auto_schedule = false
         AND EXISTS (
           SELECT 1 FROM dependencies d
           JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
           WHERE d.to_task_id = t.id
         )
       RETURNING id, name, task_code`,
      [projectId]
    )

    return NextResponse.json(success({
      updated: result.rows.length,
      message: `已启用 ${result.rows.length} 个任务的自动排程`,
    }))
  } catch (err) {
    console.error('Error enabling auto_schedule:', err)
    return NextResponse.json(failure('Internal server error', 500), { status: 500 })
  }
}
