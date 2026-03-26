import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

async function verifyOwnership(projectId: string, userId: string) {
  const r = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  )
  return r.rows.length > 0
}

// 从 tasks API 导入级联逻辑（复制实现避免跨模块依赖）
async function cascadeFsDependencies(client: PoolClient, projectId: string): Promise<string[]> {
  const cascadedIds: string[] = []
  const depsRes = await client.query(
    `SELECT d.from_task_id, d.to_task_id, d.lag FROM dependencies d
     JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
     JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
     WHERE d.project_id = $1 AND d.type = 2`,
    [projectId]
  )
  const tasksRes = await client.query(
    'SELECT id, start_date, end_date, duration, COALESCE(auto_schedule, true) AS auto_schedule FROM tasks WHERE project_id = $1 AND is_deleted = false',
    [projectId]
  )
  const taskMap = new Map<string | null, { start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean }>()
  tasksRes.rows.forEach((r: { id: string; start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean }) => {
    taskMap.set(r.id, { start_date: r.start_date, end_date: r.end_date, duration: r.duration, auto_schedule: r.auto_schedule !== false })
  })

  const toDateStr = (v: string | Date | null | undefined): string | null => {
    if (!v) return null
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0]
    const s = String(v).trim()
    if (!s) return null
    const part = s.includes('T') ? s.split('T')[0] : s.split(/\s/)[0]
    return part || null
  }
  const parseDate = (s: string | null): Date | null => {
    if (!s) return null
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  const addDays = (dateStr: string | null, days: number): string | null => {
    const s = toDateStr(dateStr)
    if (!s) return null
    const d = parseDate(s)
    if (!d) return null
    d.setDate(d.getDate() + days)
    return d.toISOString().split('T')[0]
  }
  const diffDays = (a: string, b: string): number => {
    const da = parseDate(toDateStr(a)!)
    const db = parseDate(toDateStr(b)!)
    if (!da || !db) return 0
    return Math.round((db.getTime() - da.getTime()) / 86400000)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const dep of depsRes.rows as { from_task_id: string; to_task_id: string; lag: number }[]) {
      const from = taskMap.get(dep.from_task_id)
      const to = taskMap.get(dep.to_task_id)
      if (!from?.end_date || !to?.start_date || !to.end_date) continue
      if (!to.auto_schedule) continue  // 手动排程任务不自动调整

      // FS：后继任务在前置结束的次日开始（lag=0 时），lag 为额外滞后天数
      const minStart = addDays(from.end_date, 1 + (dep.lag ?? 0))
      if (!minStart) continue
      const toStart = toDateStr(to.start_date)
      if (!toStart) continue

      // 检查后继任务是否需要调整
      // 如果后继任务开始时间早于最小允许时间，需要延后
      if (toStart >= minStart) continue  // 后续任务已经满足约束或更晚，不需要调整

      // 计算需要延后的天数
      const shift = diffDays(toStart, minStart)  // 正数表示需要延后的天数
      const newStart = minStart
      const newEnd = addDays(to.end_date, shift)
      if (!newEnd) continue

      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
         WHERE id = $4 AND project_id = $5`,
        [newStart, newEnd, diffDays(newStart, newEnd), dep.to_task_id, projectId]
      )
      cascadedIds.push(dep.to_task_id)
      taskMap.set(dep.to_task_id, { start_date: newStart, end_date: newEnd, duration: diffDays(newStart, newEnd), auto_schedule: to.auto_schedule })
      changed = true
    }
  }
  return cascadedIds
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = getAuthUser(req)
    if (!auth.ok) return NextResponse.json(auth, { status: 401 })
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

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [projectId, from_task_id, to_task_id, type, Number(lag) || 0]
      )
      let updatedTasks: Record<string, unknown>[] = []
      if (type === 2) {
        const cascadedIds = await cascadeFsDependencies(client, projectId)
        if (cascadedIds.length > 0) {
          const ph = cascadedIds.map((_, i) => `$${i + 2}`).join(',')
          const rows = await client.query(
            `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
            [projectId, ...cascadedIds]
          )
          updatedTasks = rows.rows as Record<string, unknown>[]
        }
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
  const { projectId } = await params

  if (!(await verifyOwnership(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id, type, lag } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  const r = await pool.query(
    `UPDATE dependencies
     SET type = COALESCE($1, type), lag = COALESCE($2, lag)
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [type ?? null, lag ?? null, id, projectId]
  )
  if (!r.rows[0]) return NextResponse.json(failure('Not found', 404), { status: 404 })
  return NextResponse.json(success(r.rows[0]))
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
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
