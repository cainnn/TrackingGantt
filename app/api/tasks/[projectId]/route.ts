import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

async function verifyProjectOwnership(projectId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  )
  return result.rows.length > 0
}

// Generate next task_code for a project: T-001, T-002, ...
async function nextTaskCode(client: PoolClient, projectId: string): Promise<string> {
  const res = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(task_code FROM 3) AS INTEGER)), 0) + 1 AS seq
     FROM tasks WHERE project_id = $1 AND task_code IS NOT NULL`,
    [projectId]
  )
  const seq = res.rows[0].seq as number
  return `T-${String(seq).padStart(3, '0')}`
}

// Insert a lifecycle event
async function addLifecycle(
  client: PoolClient,
  opts: {
    taskId: string; taskCode: string; projectId: string; userId: string
    event_type: string; field_name?: string | null
    old_value?: string | null; new_value?: string | null
    description: string
  }
) {
  await client.query(
    `INSERT INTO task_lifecycle
       (task_id, task_code, project_id, event_type, field_name, old_value, new_value, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [opts.taskId, opts.taskCode, opts.projectId, opts.event_type,
     opts.field_name ?? null, opts.old_value ?? null, opts.new_value ?? null,
     opts.description, opts.userId]
  )
}

const FIELD_LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期',
  duration: '工期', assignee: '责任人', percent_done: '完成度',
  parent_id: '父任务', is_milestone: '里程碑', note: '备注',
}

function fmtFieldVal(field: string, val: unknown): string {
  if (val === null || val === undefined || val === '') return '(空)'
  if (field === 'start_date' || field === 'end_date') {
    const s = String(val); return s.includes('T') ? s.split('T')[0] : s
  }
  if (field === 'duration') return `${val} 天`
  if (field === 'percent_done') return `${val}%`
  if (field === 'is_milestone') return val ? '是' : '否'
  return String(val)
}

// FS 依赖自动级联：前置任务完成后，后继任务才能开始
// type=2 为 FS (Finish-to-Start)，返回被级联更新的任务 id 列表
async function cascadeFsDependencies(client: PoolClient, projectId: string): Promise<string[]> {
  const cascadedIds: string[] = []
  const depsRes = await client.query(
    `SELECT d.id as dep_id, d.from_task_id, d.to_task_id, d.lag FROM dependencies d
     JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
     JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
     WHERE d.project_id = $1 AND d.type = 2`,
    [projectId]
  )
  console.log(`[Cascade] Found ${depsRes.rows.length} FS dependencies`)

  const tasksRes = await client.query(
    'SELECT id, start_date, end_date, duration, COALESCE(auto_schedule, true) AS auto_schedule FROM tasks WHERE project_id = $1 AND is_deleted = false',
    [projectId]
  )
  const taskMap = new Map<string | null, { start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean }>()
  tasksRes.rows.forEach((r: { id: string; start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean }) => {
    taskMap.set(r.id, { start_date: r.start_date, end_date: r.end_date, duration: r.duration, auto_schedule: r.auto_schedule !== false })
  })
  console.log(`[Cascade] Loaded ${taskMap.size} tasks`)

  const toDateStr = (v: string | Date | null | undefined): string | null => {
    if (!v) return null
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null
      // 使用本地时间而不是 UTC，避免时区偏移
      const year = v.getFullYear()
      const month = String(v.getMonth() + 1).padStart(2, '0')
      const day = String(v.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
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
    // 使用本地时间而不是 UTC，避免时区偏移
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
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
    for (const dep of depsRes.rows as { dep_id: string; from_task_id: string; to_task_id: string; lag: number }[]) {
      const from = taskMap.get(dep.from_task_id)
      const to = taskMap.get(dep.to_task_id)
      if (!from?.end_date || !to?.start_date || !to.end_date) {
        console.log(`[Cascade] Skip dep ${dep.from_task_id} -> ${dep.to_task_id}: missing dates`)
        continue
      }
      if (!to.auto_schedule) {
        console.log(`[Cascade] Skip task ${dep.to_task_id}: auto_schedule is false`)
        continue  // 手动排程任务不自动调整
      }

      // FS：后继任务在前置结束的次日开始（lag=0 时），lag 为额外滞后天数
      const minStart = addDays(from.end_date, 1 + (dep.lag ?? 0))
      if (!minStart) continue
      const toStart = toDateStr(to.start_date)
      if (!toStart) continue

      console.log(`[Cascade] Checking dep ${dep.from_task_id} -> ${dep.to_task_id}: from.end=${from.end_date}, to.start=${toStart}, minStart=${minStart}, auto=${to.auto_schedule}`)

      // 使用Date对象进行精确比较，避免字符串比较的问题
      const toDateObj = parseDate(toStart)
      const minStartDateObj = parseDate(minStart)

      if (!toDateObj || !minStartDateObj) {
        console.log(`[Cascade] Skip dep: cannot parse dates`)
        continue
      }

      // 检查后继任务是否需要调整
      // 如果后继任务的自动排程开启，无论何时都应该调整到最小允许时间
      // 这样可以确保后继任务始终紧随前置任务
      const needsAdjustment = toStart !== minStart

      if (!needsAdjustment) {
        console.log(`[Cascade] No adjustment needed: ${toStart} == ${minStart}`)
        continue
      }

      console.log(`[Cascade] Needs adjustment: ${toStart} -> ${minStart} (auto=${to.auto_schedule})`)

      // 计算需要调整的天数（正数=延后，负数=提前）
      const shift = diffDays(toStart, minStart)
      const newStart = minStart
      const newEnd = addDays(to.end_date, shift)
      if (!newEnd) continue

      console.log(`[Cascade] UPDATING task ${dep.to_task_id}: ${toStart} -> ${newStart}, ${to.end_date} -> ${newEnd}`)

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
  console.log(`[Cascade] Updated ${cascadedIds.length} tasks:`, cascadedIds)
  return cascadedIds
}

// ── Update Summary Tasks Dates ───────────────────────────────────────────
// 摘要任务的起止时间应该与所有子任务的范围一致
async function updateSummaryTasksDates(client: PoolClient, projectId: string): Promise<Record<string, unknown>[]> {
  const updated: Record<string, unknown>[] = []

  // 获取所有有子任务的任务（摘要任务）
  const parentsRes = await client.query(
    `SELECT DISTINCT parent_id
     FROM tasks
     WHERE project_id = $1 AND parent_id IS NOT NULL AND is_deleted = false`,
    [projectId]
  )

  if (parentsRes.rows.length === 0) return updated

  const parentIds = parentsRes.rows.map(r => r.parent_id as string)

  // 递归更新每个摘要任务的时间
  for (const parentId of parentIds) {
    const result = await updateSummaryTaskDateRecursive(client, parentId)
    if (result) updated.push(result)
  }

  return updated
}

// 递归更新摘要任务及其所有父级摘要任务的时间
async function updateSummaryTaskDateRecursive(client: PoolClient, taskId: string): Promise<Record<string, unknown> | null> {
  // 获取所有子任务
  const childrenRes = await client.query(
    `SELECT id, start_date, end_date
     FROM tasks
     WHERE parent_id = $1 AND is_deleted = false
     ORDER BY start_date ASC`,
    [taskId]
  )

  // 获取当前任务的信息
  const currentRes = await client.query(
    'SELECT id, name, start_date, end_date, duration, parent_id, original_start_date, original_end_date FROM tasks WHERE id = $1',
    [taskId]
  )

  const current = currentRes.rows[0]
  if (!current) return null

  if (childrenRes.rows.length === 0) {
    // 没有子任务了，如果保存了原始日期，则恢复
    if (current.original_start_date && current.original_end_date) {
      const diffDays = (a: string, b: string) => {
        const da = new Date(a)
        const db = new Date(b)
        return Math.round((db.getTime() - da.getTime()) / 86400000)
      }
      const newDuration = diffDays(current.original_start_date, current.original_end_date)

      await client.query(
        `UPDATE tasks
         SET start_date = $1, end_date = $2, duration = $3,
             original_start_date = NULL, original_end_date = NULL, updated_at = NOW()
         WHERE id = $4`,
        [current.original_start_date, current.original_end_date, newDuration, taskId]
      )

      const updated = {
        id: current.id,
        name: current.name,
        start_date: current.original_start_date,
        end_date: current.original_end_date,
        duration: newDuration,
      }

      // 递归更新父级摘要任务
      if (current.parent_id) {
        await updateSummaryTaskDateRecursive(client, current.parent_id as string)
      }

      return updated
    }
    // 没有原始日期可恢复，不做处理
    return null
  }

  // 计算时间范围：只基于子任务的日期，不包含摘要任务自己的日期
  let minStart: string | null = null
  let maxEnd: string | null = null

  for (const child of childrenRes.rows) {
    const start = child.start_date as string | null
    const end = child.end_date as string | null

    if (start && (!minStart || start < minStart)) minStart = start
    if (end && (!maxEnd || end > maxEnd)) maxEnd = end
  }

  if (!minStart || !maxEnd) return null

  // 检查是否需要更新
  if (current.start_date === minStart && current.end_date === maxEnd) {
    // 不需要更新，但检查父级摘要任务
    if (current.parent_id) {
      return await updateSummaryTaskDateRecursive(client, current.parent_id as string)
    }
    return null
  }

  // 首次成为摘要任务时，保存原始日期
  const shouldSaveOriginal = !current.original_start_date && !current.original_end_date

  // 计算新的工期
  const diffDays = (a: string, b: string) => {
    const da = new Date(a)
    const db = new Date(b)
    return Math.round((db.getTime() - da.getTime()) / 86400000)
  }
  const newDuration = diffDays(minStart, maxEnd)

  // 更新摘要任务的时间
  if (shouldSaveOriginal) {
    await client.query(
      `UPDATE tasks
       SET start_date = $1, end_date = $2, duration = $3,
           original_start_date = $4, original_end_date = $5, updated_at = NOW()
       WHERE id = $6`,
      [minStart, maxEnd, newDuration, current.start_date, current.end_date, taskId]
    )
  } else {
    await client.query(
      `UPDATE tasks
       SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
       WHERE id = $4`,
      [minStart, maxEnd, newDuration, taskId]
    )
  }

  const updated = {
    id: current.id,
    name: current.name,
    start_date: minStart,
    end_date: maxEnd,
    duration: newDuration,
  }

  // 递归更新父级摘要任务
  if (current.parent_id) {
    await updateSummaryTaskDateRecursive(client, current.parent_id as string)
  }

  return updated
}

// ── GET ───────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await cascadeFsDependencies(client, projectId)
    await client.query('COMMIT')
    const [tasksRes, depsRes] = await Promise.all([
      client.query(
        'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index ASC',
        [projectId]
      ),
      client.query(
        `SELECT d.* FROM dependencies d
         JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
         JOIN tasks tt ON tt.id = d.to_task_id   AND tt.is_deleted = false
         WHERE d.project_id = $1`,
        [projectId]
      ),
    ])
    return NextResponse.json(success({ tasks: tasksRes.rows, dependencies: depsRes.rows }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ── POST ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  const body = await req.json()
  const taskInputs = Array.isArray(body) ? body : [body]

  const client = await pool.connect()
  const inserted = []
  try {
    await client.query('BEGIN')
    for (const task of taskInputs) {
      const { name, parent_id, assignee, start_date, end_date, duration, duration_unit,
              percent_done, is_milestone, note, order_index } = task as Record<string, unknown>
      if (!name) continue

      const code = await nextTaskCode(client, projectId)

      // 确保日期格式正确：将ISO字符串或Date对象转换为YYYY-MM-DD格式
      const normalizeDate = (date: unknown): string | null => {
        if (!date) return null
        if (typeof date === 'string') {
          // 如果已经是YYYY-MM-DD格式，直接返回
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
          // 如果是ISO格式，提取日期部分
          if (date.includes('T')) return date.split('T')[0]
          return date
        }
        if (date instanceof Date) {
          const year = date.getFullYear()
          const month = String(date.getMonth() + 1).padStart(2, '0')
          const day = String(date.getDate()).padStart(2, '0')
          return `${year}-${month}-${day}`
        }
        return null
      }

      const normalizedStart = normalizeDate(start_date)
      const normalizedEnd = normalizeDate(end_date)

      const r = await client.query(
        `INSERT INTO tasks
           (project_id, parent_id, task_code, name, assignee, start_date, end_date,
            duration, duration_unit, percent_done, is_milestone, note, order_index, auto_schedule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [projectId, parent_id ?? null, code, name,
         assignee ?? null, normalizedStart, normalizedEnd,
         duration ?? null, duration_unit ?? 'day',
         percent_done ?? 0, is_milestone ?? false, note ?? null, order_index ?? 0, true]
      )
      const newTask = r.rows[0]
      inserted.push(newTask)

      await addLifecycle(client, {
        taskId: newTask.id, taskCode: code, projectId,
        userId: auth.value.userId, event_type: 'created',
        description: `创建任务「${name}」（${code}）`,
      })
    }

    // 更新摘要任务的时间范围
    await updateSummaryTasksDates(client, projectId)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return NextResponse.json(success(inserted), { status: 201 })
}

// ── PUT ───────────────────────────────────────────────────────────────────
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  const body = await req.json()
  const taskInputs = Array.isArray(body) ? body : [body]

  const client = await pool.connect()
  const updated = []
  try {
    await client.query('BEGIN')

    for (const task of taskInputs) {
      const { id } = task as { id: string }
      if (!id) continue

      // Fetch current state for diff
      const prev = await client.query(
        'SELECT * FROM tasks WHERE id = $1 AND project_id = $2 AND is_deleted = false',
        [id, projectId]
      )
      if (!prev.rows.length) continue
      const old = prev.rows[0]

      const hasParentKey = 'parent_id' in task
      const hasAssigneeKey = 'assignee' in task

      // 确保日期格式正确
      const normalizeDate = (date: unknown): string | null => {
        if (!date) return null
        if (typeof date === 'string') {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
          if (date.includes('T')) return date.split('T')[0]
          return date
        }
        if (date instanceof Date) {
          const year = date.getFullYear()
          const month = String(date.getMonth() + 1).padStart(2, '0')
          const day = String(date.getDate()).padStart(2, '0')
          return `${year}-${month}-${day}`
        }
        return null
      }

      const hasAutoScheduleKey = 'auto_schedule' in task
      const r = await client.query(
        `UPDATE tasks SET
           name         = COALESCE($1, name),
           parent_id    = CASE WHEN $13 THEN $2 ELSE parent_id END,
           assignee     = CASE WHEN $14 THEN $3 ELSE assignee END,
           start_date   = COALESCE($4, start_date),
           end_date     = COALESCE($5, end_date),
           duration     = COALESCE($6, duration),
           duration_unit= COALESCE($7, duration_unit),
           percent_done = COALESCE($8, percent_done),
           is_milestone = COALESCE($9, is_milestone),
           note         = $10,
           order_index  = COALESCE($11, order_index),
           auto_schedule= CASE WHEN $16 THEN $17 ELSE auto_schedule END,
           updated_at   = NOW()
         WHERE id = $12 AND project_id = $15
         RETURNING *`,
        [
          (task as Record<string, unknown>).name ?? null,
          (task as Record<string, unknown>).parent_id ?? null,
          (task as Record<string, unknown>).assignee ?? null,
          normalizeDate((task as Record<string, unknown>).start_date),
          normalizeDate((task as Record<string, unknown>).end_date),
          (task as Record<string, unknown>).duration ?? null,
          (task as Record<string, unknown>).duration_unit ?? null,
          (task as Record<string, unknown>).percent_done ?? null,
          (task as Record<string, unknown>).is_milestone ?? null,
          (task as Record<string, unknown>).note ?? null,
          (task as Record<string, unknown>).order_index ?? null,
          id, hasParentKey, hasAssigneeKey, projectId,
          hasAutoScheduleKey, (task as Record<string, unknown>).auto_schedule ?? true,
        ]
      )
      if (!r.rows[0]) continue
      const cur = r.rows[0]
      updated.push(cur)

      const code: string = cur.task_code ?? old.task_code ?? id.slice(0, 8)

      // ── Detect position move (order_index or parent_id changed) ────────
      const parentChanged = hasParentKey && String(old.parent_id ?? '') !== String(cur.parent_id ?? '')
      const orderChanged  = (task as Record<string, unknown>).order_index !== undefined
                         && old.order_index !== cur.order_index

      if (parentChanged || orderChanged) {
        let desc: string
        if (parentChanged && cur.parent_id === null) {
          desc = `任务「${cur.name}」（${code}）升级为顶级任务`
        } else if (parentChanged) {
          // look up new parent name
          const parentRes = await client.query('SELECT name, task_code FROM tasks WHERE id = $1', [cur.parent_id])
          const pName = parentRes.rows[0]?.name ?? cur.parent_id
          const pCode = parentRes.rows[0]?.task_code ?? ''
          desc = `任务「${cur.name}」（${code}）移至子任务，父级：「${pName}」（${pCode}）`
        } else {
          const dir = cur.order_index < old.order_index ? '上移' : '下移'
          desc = `任务「${cur.name}」（${code}）${dir}（排序 ${old.order_index} → ${cur.order_index}）`
        }
        await addLifecycle(client, {
          taskId: id, taskCode: code, projectId, userId: auth.value.userId,
          event_type: 'moved',
          field_name: parentChanged ? 'parent_id' : 'order_index',
          old_value: parentChanged ? String(old.parent_id ?? '顶级') : String(old.order_index),
          new_value: parentChanged ? String(cur.parent_id ?? '顶级') : String(cur.order_index),
          description: desc,
        })

        // ── When parent_id changes, update both old and new parent task dates ────────
        if (parentChanged) {
          // Update old parent (lost a child)
          if (old.parent_id) {
            const oldParentUpdate = await updateSummaryTaskDateRecursive(client, old.parent_id)
            if (oldParentUpdate && !updated.some((u: { id: string }) => u.id === oldParentUpdate.id)) {
              updated.push(oldParentUpdate)
            }
          }
          // Update new parent (gained a child)
          if (cur.parent_id) {
            const newParentUpdate = await updateSummaryTaskDateRecursive(client, cur.parent_id)
            if (newParentUpdate && !updated.some((u: { id: string }) => u.id === newParentUpdate.id)) {
              updated.push(newParentUpdate)
            }
          }
        }
      }

      // ── Detect field updates ────────────────────────────────────────────
      const COMPARE_FIELDS = ['name','start_date','end_date','duration','assignee','percent_done','is_milestone','note']
      for (const f of COMPARE_FIELDS) {
        if (!(f in task)) continue
        const norm = (v: unknown) => {
          if (v === null || v === undefined) return ''
          const s = String(v); return s.includes('T') ? s.split('T')[0] : s
        }
        const ov = norm(old[f])
        const nv = norm(cur[f])
        if (ov === nv) continue
        const label = FIELD_LABELS[f] ?? f
        const ovStr = fmtFieldVal(f, old[f])
        const nvStr = fmtFieldVal(f, cur[f])
        let desc: string
        if (f === 'duration') {
          const diff = Number(cur[f] ?? 0) - Number(old[f] ?? 0)
          desc = diff > 0
            ? `任务「${cur.name}」（${code}）工期延长 ${diff} 天（${ovStr} → ${nvStr}）`
            : `任务「${cur.name}」（${code}）工期缩短 ${Math.abs(diff)} 天（${ovStr} → ${nvStr}）`
        } else if (f === 'name') {
          desc = `任务（${code}）重命名：「${ovStr}」→「${nvStr}」`
        } else {
          desc = `任务「${cur.name}」（${code}）${label}：${ovStr} → ${nvStr}`
        }
        await addLifecycle(client, {
          taskId: id, taskCode: code, projectId, userId: auth.value.userId,
          event_type: 'updated', field_name: f,
          old_value: ovStr, new_value: nvStr, description: desc,
        })

        // ── When task date changes, update parent summary task dates ────────────
        if (f === 'start_date' || f === 'end_date') {
          if (cur.parent_id) {
            const parentUpdate = await updateSummaryTaskDateRecursive(client, cur.parent_id)
            if (parentUpdate && !updated.some((u: { id: string }) => u.id === parentUpdate.id)) {
              updated.push(parentUpdate)
            }
          }
        }
      }
    }

    // FS 依赖自动级联：确保后继任务开始日期 >= 前置任务结束日期 + lag
    const cascadedIds = await cascadeFsDependencies(client, projectId)
    if (cascadedIds.length > 0) {
      const ph = cascadedIds.map((_, i) => `$${i + 2}`).join(',')
      const cascadedRows = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
        [projectId, ...cascadedIds]
      )
      cascadedRows.rows.forEach((r: Record<string, unknown>) => {
        if (!updated.some((u: { id: string }) => u.id === r.id)) updated.push(r)
      })
    }

    // 更新摘要任务的时间范围：摘要任务的起止时间应该与所有子任务的范围一致
    const summaryUpdated = await updateSummaryTasksDates(client, projectId)
    if (summaryUpdated.length > 0) {
      summaryUpdated.forEach(r => {
        if (!updated.some((u: { id: string }) => u.id === r.id)) updated.push(r)
      })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return NextResponse.json(success(updated))
}

// ── DELETE (soft) ─────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  const body = await req.json()
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [body.id]
  if (!ids.length) return NextResponse.json(failure('No IDs provided', 400), { status: 400 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Collect all descendants recursively for cascade soft-delete
    const allIds = new Set<string>(ids)
    let frontier = [...ids]
    while (frontier.length) {
      const ph = frontier.map((_, i) => `$${i + 1}`).join(',')
      const children = await client.query(
        `SELECT id FROM tasks WHERE parent_id IN (${ph}) AND is_deleted = false`,
        frontier
      )
      const childIds = children.rows.map((r: { id: string }) => r.id).filter((id: string) => !allIds.has(id))
      childIds.forEach((id: string) => allIds.add(id))
      frontier = childIds
    }

    const allIdArr = [...allIds]
    const ph = allIdArr.map((_, i) => `$${i + 2}`).join(',')

    // Fetch tasks for lifecycle before soft-deleting
    const toDelete = await client.query(
      `SELECT id, task_code, name FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
      [projectId, ...allIdArr]
    )

    // Soft-delete
    await client.query(
      `UPDATE tasks SET is_deleted = true, deleted_at = NOW()
       WHERE project_id = $1 AND id IN (${ph})`,
      [projectId, ...allIdArr]
    )

    // Lifecycle events
    for (const t of toDelete.rows) {
      await addLifecycle(client, {
        taskId: t.id, taskCode: t.task_code ?? t.id.slice(0, 8),
        projectId, userId: auth.value.userId,
        event_type: 'deleted',
        description: `删除任务「${t.name}」（${t.task_code ?? ''}）`,
      })
    }

    await client.query('COMMIT')
    return NextResponse.json(success({ deleted: allIdArr }))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
