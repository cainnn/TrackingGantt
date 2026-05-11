import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { wouldCreateCycle, cascadeDependencies, updateSummaryTasksDates } from '@/lib/scheduling'

type Params = { params: Promise<{ projectId: string }> }

const DEP_TYPE_LABEL = ['SS', 'SF', 'FS', 'FF']

async function verifyOwnership(projectId: string, userId: string) {
  const r = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  )
  return r.rows.length > 0
}

async function fetchTaskInfo(client: PoolClient, taskIds: string[]): Promise<Map<string, { task_code: string; name: string }>> {
  if (taskIds.length === 0) return new Map()
  const ph = taskIds.map((_, i) => `$${i + 1}`).join(',')
  const r = await client.query(
    `SELECT id, task_code, name FROM tasks WHERE id IN (${ph})`,
    taskIds,
  )
  const m = new Map<string, { task_code: string; name: string }>()
  for (const row of r.rows) m.set(row.id, { task_code: row.task_code, name: row.name })
  return m
}

async function logDepLifecycle(
  client: PoolClient,
  opts: {
    taskId: string; taskCode: string; projectId: string; userId: string
    event_type: string; description: string
  },
) {
  await client.query(
    `INSERT INTO task_lifecycle
       (task_id, task_code, project_id, event_type, field_name, old_value, new_value, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [opts.taskId, opts.taskCode, opts.projectId, opts.event_type,
     'dependency', null, null, opts.description, opts.userId],
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = getAuthUser(req)
    if (!auth.ok) return NextResponse.json(auth, { status: 401 })
    const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
    const { projectId } = await params

    if (!(await verifyOwnership(projectId, auth.value.userId)))
      return NextResponse.json(failure('Not found', 404), { status: 404 })

    let body: { id?: string; from_task_id?: string; to_task_id?: string; type?: number; lag?: number; active?: boolean }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(failure('Invalid JSON body', 400), { status: 400 })
    }
    const { id, from_task_id, to_task_id, type = 2, lag = 0, active = true } = body
    if (!from_task_id || !to_task_id)
      return NextResponse.json(failure('from_task_id and to_task_id required', 400), { status: 400 })
    if (from_task_id === to_task_id)
      return NextResponse.json(failure('任务不能依赖自身', 400), { status: 400 })

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

    const existingDeps = await pool.query(
      `SELECT from_task_id, to_task_id FROM dependencies WHERE project_id = $1`,
      [projectId]
    )
    if (wouldCreateCycle(from_task_id, to_task_id, existingDeps.rows))
      return NextResponse.json(failure('创建该依赖会产生循环依赖', 400), { status: 400 })

    const clientId = (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ? id : null

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `INSERT INTO dependencies (id, project_id, from_task_id, to_task_id, type, lag, active)
         VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7) RETURNING *`,
        [clientId, projectId, from_task_id, to_task_id, type, Number(lag) || 0, active],
      )
      await client.query(
        `UPDATE tasks SET auto_schedule = true, updated_at = NOW()
         WHERE id = $1 AND project_id = $2 AND auto_schedule = false`,
        [to_task_id, projectId]
      )

      // 写依赖 lifecycle
      const taskInfo = await fetchTaskInfo(client, [from_task_id, to_task_id])
      const fromI = taskInfo.get(from_task_id)
      const toI = taskInfo.get(to_task_id)
      if (fromI && toI) {
        const typeLabel = DEP_TYPE_LABEL[type] ?? 'FS'
        const lagStr = Number(lag) ? ` (lag=${lag}d)` : ''
        await logDepLifecycle(client, {
          taskId: to_task_id, taskCode: toI.task_code, projectId,
          userId: auth.value.userId, event_type: 'dep_added',
          description: `添加${typeLabel}依赖：「${fromI.name}」(${fromI.task_code}) → 「${toI.name}」(${toI.task_code})${lagStr}`,
        })
      }

      const cascadedIds = await cascadeDependencies(client, projectId)
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

    // 查询旧值用于 lifecycle
    const oldRes = await client.query(
      `SELECT * FROM dependencies WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    )
    const old = oldRes.rows[0]
    if (!old) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Not found', 404), { status: 404 })
    }

    const r = await client.query(
      `UPDATE dependencies
       SET type = COALESCE($1, type),
           lag  = COALESCE($2, lag),
           active = COALESCE($5, active)
       WHERE id = $3 AND project_id = $4 RETURNING *`,
      [type ?? null, lag ?? null, id, projectId, active ?? null]
    )
    const cur = r.rows[0]

    // 依赖 lifecycle
    const taskInfo = await fetchTaskInfo(client, [old.from_task_id, old.to_task_id])
    const fromI = taskInfo.get(old.from_task_id)
    const toI = taskInfo.get(old.to_task_id)
    if (fromI && toI) {
      const oldType = DEP_TYPE_LABEL[old.type] ?? 'FS'
      const newType = DEP_TYPE_LABEL[cur.type] ?? 'FS'
      const oldLag = old.lag ?? 0
      const newLag = cur.lag ?? 0
      const oldAct = old.active ?? true
      const newAct = cur.active ?? true
      const parts: string[] = []
      if (oldType !== newType) parts.push(`类型 ${oldType}→${newType}`)
      if (oldLag !== newLag) parts.push(`lag ${oldLag}d→${newLag}d`)
      if (oldAct !== newAct) parts.push(newAct ? '启用' : '禁用')
      if (parts.length > 0) {
        await logDepLifecycle(client, {
          taskId: old.to_task_id, taskCode: toI.task_code, projectId,
          userId: auth.value.userId, event_type: 'dep_updated',
          description: `修改依赖「${fromI.name}」(${fromI.task_code}) → 「${toI.name}」(${toI.task_code})：${parts.join('，')}`,
        })
      }
    }

    const cascadedIds = await cascadeDependencies(client, projectId)
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
      dependency: cur,
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

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // 取出旧依赖用于 lifecycle，并在级联前删除
    const oldRes = await client.query(
      `SELECT * FROM dependencies WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    )
    const old = oldRes.rows[0]
    if (!old) {
      await client.query('ROLLBACK')
      return NextResponse.json(success({ deleted: id }))
    }
    await client.query(
      'DELETE FROM dependencies WHERE id = $1 AND project_id = $2',
      [id, projectId],
    )

    const taskInfo = await fetchTaskInfo(client, [old.from_task_id, old.to_task_id])
    const fromI = taskInfo.get(old.from_task_id)
    const toI = taskInfo.get(old.to_task_id)
    if (fromI && toI) {
      const typeLabel = DEP_TYPE_LABEL[old.type] ?? 'FS'
      await logDepLifecycle(client, {
        taskId: old.to_task_id, taskCode: toI.task_code, projectId,
        userId: auth.value.userId, event_type: 'dep_removed',
        description: `删除${typeLabel}依赖：「${fromI.name}」(${fromI.task_code}) → 「${toI.name}」(${toI.task_code})`,
      })
    }

    // 删除依赖后重新级联，让后继任务回到独立排程
    const cascadedIds = await cascadeDependencies(client, projectId)
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
    return NextResponse.json(success({ deleted: id, updatedTasks }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('DELETE /api/dependencies:', err)
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json(failure(msg, 500), { status: 500 })
  } finally {
    client.release()
  }
}
