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
    const { taskId } = body

    if (!taskId) {
      return NextResponse.json(failure('taskId is required', 400), { status: 400 })
    }

    // 直接修复任务：不触发级联更新
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 获取前置任务的结束日期
      const depRes = await client.query(
        `SELECT d.from_task_id, t.end_date
         FROM dependencies d
         JOIN tasks t ON t.id = d.from_task_id
         WHERE d.to_task_id = $1 AND d.project_id = $2 AND d.type = 2`,
        [taskId, projectId]
      )

      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return NextResponse.json(failure('No predecessor found', 400), { status: 400 })
      }

      const predecessorEndDate = depRes.rows[0].end_date
      if (!predecessorEndDate) {
        await client.query('ROLLBACK')
        return NextResponse.json(failure('Predecessor has no end date', 400), { status: 400 })
      }

      // 计算新的开始日期（前置任务结束日期 + 1天）
      const newStartDate = new Date(predecessorEndDate)
      newStartDate.setDate(newStartDate.getDate() + 1)
      const newStartDateStr = newStartDate.toISOString().split('T')[0]

      // 获取任务工期
      const taskRes = await client.query(
        'SELECT duration FROM tasks WHERE id = $1',
        [taskId]
      )

      if (taskRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return NextResponse.json(failure('Task not found', 404), { status: 404 })
      }

      const duration = taskRes.rows[0].duration || 0

      // 计算新的结束日期
      const newEndDate = new Date(newStartDate)
      newEndDate.setDate(newEndDate.getDate() + duration)
      const newEndDateStr = newEndDate.toISOString().split('T')[0]

      // 直接更新任务（绕过级联逻辑）
      await client.query(
        `UPDATE tasks
         SET start_date = $1, end_date = $2, auto_schedule = true, updated_at = NOW()
         WHERE id = $3 AND project_id = $4`,
        [newStartDateStr, newEndDateStr, taskId, projectId]
      )

      await client.query('COMMIT')

      return NextResponse.json(success({
        message: '任务已修复',
        start_date: newStartDateStr,
        end_date: newEndDateStr
      }))
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Error fixing task:', err)
    return NextResponse.json(failure('Internal server error', 500), { status: 500 })
  }
}
