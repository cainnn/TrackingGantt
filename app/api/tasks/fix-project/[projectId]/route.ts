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

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. 获取所有任务及其依赖关系
    const tasksRes = await client.query(
      'SELECT id, name, start_date, end_date, duration FROM tasks WHERE project_id = $1 AND is_deleted = false',
      [projectId]
    )

    const depsRes = await client.query(
      `SELECT d.from_task_id, d.to_task_id, d.lag
       FROM dependencies d
       WHERE d.project_id = $1 AND d.type = 2`,
      [projectId]
    )

    let fixedCount = 0

    // 2. 对于每个依赖关系，更新后继任务
    for (const dep of depsRes.rows) {
      const fromTask = tasksRes.rows.find((t: any) => t.id === dep.from_task_id)
      const toTask = tasksRes.rows.find((t: any) => t.id === dep.to_task_id)

      if (!fromTask?.end_date || !toTask) continue

      // 计算后继任务的最小开始日期（前置任务结束日期 + 1天 + lag）
      const endDate = new Date(fromTask.end_date)
      const lag = dep.lag || 0
      const minStartDate = new Date(endDate)
      minStartDate.setDate(minStartDate.getDate() + 1 + lag)

      const minStartDateStr = minStartDate.toISOString().split('T')[0]

      // 更新后继任务
      await client.query(
        `UPDATE tasks
         SET start_date = $1,
             end_date = ($1::date + (duration || 0) * interval '1 day')::date,
             auto_schedule = true,
             updated_at = NOW()
         WHERE id = $2 AND project_id = $3`,
        [minStartDateStr, dep.to_task_id, projectId]
      )

      fixedCount++
    }

    await client.query('COMMIT')

    return NextResponse.json(success({
      fixed: fixedCount,
      message: `已修复 ${fixedCount} 个任务的日期和自动排程设置`
    }))
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Error fixing project:', err)
    return NextResponse.json(failure('Internal server error', 500), { status: 500 })
  } finally {
    client.release()
  }
}
