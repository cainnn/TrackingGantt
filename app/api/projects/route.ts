import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

export async function GET(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  // view/administrator 用户可查看所有项目，admin 只看自己的
  const projectsResult = (auth.value.role === 'view' || auth.value.role === 'administrator')
    ? await pool.query('SELECT * FROM projects ORDER BY created_at DESC')
    : await pool.query('SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC', [auth.value.userId])

  // 为每个项目计算进度和预计完成时间
  const projects = await Promise.all(
    projectsResult.rows.map(async (p: any) => {
      const progressResult = await pool.query(
        `SELECT
           COALESCE(SUM(t.duration), 0) as total_duration,
           COALESCE(SUM(
             t.duration *
             CASE
               WHEN $2::timestamp IS NULL THEN t.percent_done / 100.0
               WHEN t.end_date <= $2::timestamp THEN 1.0
               WHEN t.start_date >= $2::timestamp THEN 0
               ELSE LEAST(1.0,
                 GREATEST(0,
                   EXTRACT(EPOCH FROM ($2::timestamp - t.start_date))
                   / NULLIF(EXTRACT(EPOCH FROM (t.end_date - t.start_date)), 0)
                 ))
             END
           ), 0) as completed_duration
         FROM tasks t
         WHERE t.project_id = $1
           AND t.is_deleted = false
           AND t.start_date IS NOT NULL
           AND t.end_date IS NOT NULL
           AND t.duration IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM tasks c
             WHERE c.parent_id = t.id AND c.is_deleted = false
           )`,
        [p.id, p.status_date ?? null]
      )

      const totalDuration = Number(progressResult.rows[0].total_duration) || 0
      const completedDuration = Number(progressResult.rows[0].completed_duration) || 0
      const progress = totalDuration > 0 ? Math.round((completedDuration / totalDuration) * 100) : 0

      // 预计完成时间：取所有任务中最晚的 end_date
      const endResult = await pool.query(
        `SELECT MAX(end_date) as max_end
         FROM tasks
         WHERE project_id = $1 AND is_deleted = false
           AND end_date IS NOT NULL`,
        [p.id]
      )
      const maxEnd = endResult.rows[0]?.max_end
      const estimated_end_date = maxEnd
        ? (maxEnd instanceof Date
            ? `${maxEnd.getFullYear()}-${String(maxEnd.getMonth()+1).padStart(2,'0')}-${String(maxEnd.getDate()).padStart(2,'0')}`
            : String(maxEnd).split('T')[0])
        : null

      return {
        ...p,
        progress,
        estimated_end_date,
      }
    })
  )

  return NextResponse.json(success(projects))
}

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock

  const body = await req.json()
  const { name, start_date, end_date, status_date, copy_from, time_granularity } = body as {
    name?: string
    start_date?: string
    end_date?: string
    status_date?: string
    copy_from?: string
    time_granularity?: 'day' | 'minute'
  }

  if (!name) {
    return NextResponse.json(failure('name is required', 400), { status: 400 })
  }

  // If copying from another project, use its dates as defaults
  let srcProject: Record<string, unknown> | null = null
  if (copy_from) {
    const srcRes = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [copy_from, auth.value.userId]
    )
    if (srcRes.rows.length === 0) {
      return NextResponse.json(failure('Source project not found', 404), { status: 404 })
    }
    srcProject = srcRes.rows[0]
  }

  // 粒度：显式传入 > 复制源继承 > 默认天级
  const granularity: 'day' | 'minute' =
    time_granularity === 'minute' || time_granularity === 'day'
      ? time_granularity
      : ((srcProject?.time_granularity as 'day' | 'minute' | undefined) ?? 'day')

  const result = await pool.query(
    'INSERT INTO projects (user_id, name, start_date, end_date, status_date, time_granularity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [
      auth.value.userId,
      name,
      start_date ?? (srcProject?.start_date as string | null) ?? null,
      end_date ?? (srcProject?.end_date as string | null) ?? null,
      status_date ?? (srcProject?.status_date as string | null) ?? null,
      granularity,
    ]
  )
  const newProject = result.rows[0]

  // Copy tasks and dependencies from source project
  if (copy_from) {
    try {
      const srcTasks = await pool.query(
        'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index',
        [copy_from]
      )
      const srcDeps = await pool.query(
        'SELECT * FROM dependencies WHERE project_id = $1',
        [copy_from]
      )

      // Map old task id -> new task id
      const idMap = new Map<string, string>()
      for (const t of srcTasks.rows) {
        idMap.set(t.id, randomUUID())
      }

      // Sort tasks: parents before children (topological order)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted: any[] = []
      const inserted = new Set<string>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const taskMap = new Map<string, any>(srcTasks.rows.map((t: any) => [t.id, t]))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function addTask(t: any) {
        if (inserted.has(t.id)) return
        if (t.parent_id && taskMap.has(t.parent_id) && !inserted.has(t.parent_id)) {
          addTask(taskMap.get(t.parent_id)!)
        }
        sorted.push(t)
        inserted.add(t.id)
      }
      for (const t of srcTasks.rows) addTask(t)

      // Insert tasks (parents first)
      for (const t of sorted) {
        const newId = idMap.get(t.id)!
        const newParentId = t.parent_id ? (idMap.get(t.parent_id) ?? null) : null
        await pool.query(
          `INSERT INTO tasks (id, project_id, parent_id, task_code, name, assignee,
           start_date, end_date, duration, is_milestone, auto_schedule, note, order_index,
           is_deleted, percent_done, duration_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            newId, newProject.id, newParentId, t.task_code, t.name, t.assignee,
            t.start_date, t.end_date, t.duration, t.is_milestone,
            t.auto_schedule, t.note, t.order_index,
            false, 0, t.duration_unit ?? 'day',
          ]
        )
      }

      // Insert dependencies
      for (const d of srcDeps.rows) {
        const fromId = idMap.get(d.from_task_id)
        const toId = idMap.get(d.to_task_id)
        if (!fromId || !toId) continue
        await pool.query(
          `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag)
           VALUES ($1,$2,$3,$4,$5)`,
          [newProject.id, fromId, toId, d.type, d.lag]
        )
      }
    } catch (err) {
      console.error('Copy project tasks error:', err)
      // Project was created, tasks copy failed - still return project
    }
  }

  return NextResponse.json(success(newProject), { status: 201 })
}
