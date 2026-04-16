import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { wouldCreateCycle, cascadeDependencies, updateSummaryTasksDates } from '@/lib/scheduling'

type Params = { params: Promise<{ projectId: string }> }

async function verifyOwnership(projectId: string, userId: string) {
  const r = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  )
  return r.rows.length > 0
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = getAuthUser(req)
    if (!auth.ok) return NextResponse.json(auth, { status: 401 })
    const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
    const { projectId } = await params

    if (!(await verifyOwnership(projectId, auth.value.userId)))
      return NextResponse.json(failure('Not found', 404), { status: 404 })

    let body: { from_task_id?: string; to_task_id?: string; type?: number; lag?: number }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(failure('Invalid JSON body', 400), { status: 400 })
    }
    const { from_task_id, to_task_id, type = 2, lag = 0 } = body
    if (!from_task_id || !to_task_id)
      return NextResponse.json(failure('from_task_id and to_task_id required', 400), { status: 400 })

    // 自依赖检查
    if (from_task_id === to_task_id)
      return NextResponse.json(failure('任务不能依赖自身', 400), { status: 400 })

    // 摘要任务（有子任务）不能作为依赖的起点或终点
    const summaryCheck = await pool.query(
      `SELECT DISTINCT parent_id FROM tasks
       WHERE project_id = $1 AND parent_id IN ($2, $3) AND is_deleted = false`,
      [projectId, from_task_id, to_task_id]
    )
    const summaryIds = new Set(summaryCheck.rows.map((r: { parent_id: string }) => r.parent_id))
    if (summaryIds.has(from_task_id))
      return NextResponse.json(failure('摘要任务不能作为依赖的前置任务', 400), { status: 400 })
    if (summaryIds.has(to_task_id))
      return NextResponse.json(failure('摘要任务不能作为依赖的后继任务', 400), { status: 400 })

    // 循环依赖检测
    const existingDeps = await pool.query(
      `SELECT from_task_id, to_task_id FROM dependencies WHERE project_id = $1`,
      [projectId]
    )
    if (wouldCreateCycle(from_task_id, to_task_id, existingDeps.rows))
      return NextResponse.json(failure('创建该依赖会产生循环依赖', 400), { status: 400 })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [projectId, from_task_id, to_task_id, type, Number(lag) || 0]
      )
      // 添加依赖时，自动将后继任务切换为自动排程，否则级联无法调整其日期
      await client.query(
        `UPDATE tasks SET auto_schedule = true, updated_at = NOW()
         WHERE id = $1 AND project_id = $2 AND auto_schedule = false`,
        [to_task_id, projectId]
      )
      const cascadedIds = await cascadeDependencies(client, projectId)
      // 级联后更新摘要任务日期
      const summaryUpdated = await updateSummaryTasksDates(client, projectId)

      const allUpdatedIds = [...new Set([...cascadedIds, ...summaryUpdated.map(s => s.id)])]
      let updatedTasks: Record<string, unknown>[] = []
      if (allUpdatedIds.length > 0) {
        const ph = allUpdatedIds.map((_, i) => `$${i + 2}`).join(',')
        const rows = await client.query(
          `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
          [projectId, ...allUpdatedIds]
        )
        updatedTasks = rows.rows as Record<string, unknown>[]
      }
      await client.query('COMMIT')
      return NextResponse.json(success({
        dependency: r.rows[0],
        updatedTask: updatedTasks[0] ?? null,
        updatedTasks,
      }), { status: 201 })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('POST /api/dependencies:', err)
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json(failure(msg, 500), { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (!(await verifyOwnership(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id, type, lag, active } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const r = await client.query(
      `UPDATE dependencies
       SET type = COALESCE($1, type),
           lag  = COALESCE($2, lag),
           active = COALESCE($5, active)
       WHERE id = $3 AND project_id = $4 RETURNING *`,
      [type ?? null, lag ?? null, id, projectId, active ?? null]
    )
    if (!r.rows[0]) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Not found', 404), { status: 404 })
    }

    // 修改依赖类型/延迟后必须重新级联
    const cascadedIds = await cascadeDependencies(client, projectId)
    const summaryUpdated = await updateSummaryTasksDates(client, projectId)

    // 合并级联更新 + 摘要任务更新的 ID
    const allUpdatedIds = [...new Set([...cascadedIds, ...summaryUpdated.map(s => s.id)])]
    let updatedTasks: Record<string, unknown>[] = []
    if (allUpdatedIds.length > 0) {
      const ph = allUpdatedIds.map((_, i) => `$${i + 2}`).join(',')
      const rows = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
        [projectId, ...allUpdatedIds]
      )
      updatedTasks = rows.rows as Record<string, unknown>[]
    }

    await client.query('COMMIT')
    return NextResponse.json(success({
      dependency: r.rows[0],
      updatedTasks,
    }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('PUT /api/dependencies:', err)
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json(failure(msg, 500), { status: 500 })
  } finally {
    client.release()
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (!(await verifyOwnership(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  await pool.query(
    'DELETE FROM dependencies WHERE id = $1 AND project_id = $2',
    [id, projectId]
  )
  return NextResponse.json(success({ deleted: id }))
}
