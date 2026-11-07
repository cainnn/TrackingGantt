import { hasProjectAccess } from '@/lib/projectAccess'
import { isUuid } from '@/lib/projectAccessPolicy'
import { randomUUID } from 'node:crypto'
import { planSubmittedHierarchy, isSubmittedTaskBatch, type HierarchyTask, type HierarchyRepair } from '@/lib/submittedTaskHierarchy'
import { persistSubmittedHierarchy } from '@/lib/server/submittedHierarchy'
import { addLifecycle, addLifecycleBatch, normalizeChangeReason, type LifecycleInput } from '@/lib/taskLifecycle'
import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { normalizeDurationMinutes } from '@/lib/taskNumbers'
import {
  type TaskLike,
  toDateStr, addDaysStr,
  cascadeDependencies, collapseDeletedTaskSuccessors, updateSummaryTasksDates, updateSummaryTaskDateRecursive,
  snapTasksToDayLevel,
} from '@/lib/scheduling'

type Params = { params: Promise<{ projectId: string }> }

async function lockProjectTx(client: PoolClient, projectId: string): Promise<void> {
  await client.query('SET LOCAL lock_timeout = \'10s\'')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])
}

// Generate next task_code for a project: 1, 2, 3, ...
async function nextTaskCode(client: PoolClient, projectId: string): Promise<string> {
  const res = await client.query(
    `SELECT COALESCE(MAX(
       CASE WHEN task_code ~ '^\\d+$' THEN CAST(task_code AS INTEGER)
            WHEN task_code ~ '^T-' THEN CAST(SUBSTRING(task_code FROM 3) AS INTEGER)
            ELSE 0 END
     ), 0) + 1 AS seq
     FROM tasks WHERE project_id = $1 AND task_code IS NOT NULL`,
    [projectId]
  )
  const seq = res.rows[0].seq as number
  return String(seq)
}

async function taskCodeExists(client: PoolClient, projectId: string, taskCode: string): Promise<boolean> {
  const res = await client.query(
    'SELECT 1 FROM tasks WHERE project_id = $1 AND task_code = $2 LIMIT 1',
    [projectId, taskCode],
  )
  return res.rows.length > 0
}

const FIELD_LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期',
  duration: '工期', assignee: '责任人', percent_done: '完成度',
  parent_id: '父任务', is_milestone: '里程碑', note: '备注',
}

function fmtFieldVal(field: string, val: unknown, opts?: { isMinute?: boolean }): string {
  if (val === null || val === undefined || val === '') return '(空)'
  if (field === 'start_date' || field === 'end_date' || field === 'constraint_date' || field === 'deadline') {
    // Date 对象（pg timestamp 列返回值）→ 按本地 TZ 格式化为 'YYYY-MM-DD HH:mm'
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return ''
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${val.getFullYear()}-${pad(val.getMonth()+1)}-${pad(val.getDate())} ` +
             `${pad(val.getHours())}:${pad(val.getMinutes())}`
    }
    // 'YYYY-MM-DDTHH:mm:ss' → 'YYYY-MM-DD HH:mm'，无时间则保持原样
    const s = String(val)
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
    return m ? `${m[1]} ${m[2]}` : s
  }
  if (field === 'duration') {
    const n = Number(val)
    if (!Number.isFinite(n)) return String(val)
    // 天级项目：duration 是分钟，但按天换算显示；分钟级保留原值
    if (opts?.isMinute === false) {
      const days = Math.round(n / 1440)
      return `${days} 天`
    }
    return `${n} 分钟`
  }
  if (field === 'percent_done') return `${val}%`
  if (field === 'is_milestone') return val ? '是' : '否'
  return String(val)
}

// 日期工具函数、级联、摘要任务更新 → 统一从 @/lib/scheduling 导入


// ── GET ───────────────────────────────────────────────────────────────────
// Read-only: 加载图表时不要持锁、不要级联控写，避免与 PUT/其它会话竞争导致 lock_timeout，
// 前端收到非 ok 后静默不写入 Redux，界面会一直像「空项目」。
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  {
    let owned: boolean
    try {
      owned = await hasProjectAccess(projectId, auth.value)
    } catch (err) {
      console.error('GET /api/tasks verifyOwnership error:', err)
      return NextResponse.json(failure('数据库连接失败', 500), { status: 500 })
    }
    if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }

  const [tasksRes, depsRes] = await Promise.all([
    pool.query(
      'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index ASC',
      [projectId]
    ),
    pool.query(
      `SELECT d.* FROM dependencies d
       JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
       JOIN tasks tt ON tt.id = d.to_task_id   AND tt.is_deleted = false
       WHERE d.project_id = $1`,
      [projectId]
    ),
  ])

  // Loading or retrying a save must never repair/cascade/write the stored plan.
  return NextResponse.json(success({ tasks: tasksRes.rows, dependencies: depsRes.rows }))
}

// ── POST ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  const owned = await hasProjectAccess(projectId, auth.value)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('请求体解析失败', 400), { status: 400 })
  }
  const submittedPlan = req.headers.get('x-gantt-confirmed-save') === '1' || isSubmittedTaskBatch(body)
  const taskInputs = (Array.isArray(body) ? body : [body]).filter(t => t && typeof t === 'object')
    .map(t => ({ ...t, id: isUuid(t.id) ? t.id : randomUUID() }))
  let hierarchyRepairs: HierarchyRepair[] = []

  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    console.error('POST /api/tasks pool.connect error:', err)
    return NextResponse.json(failure('数据库连接池繁忙，请稍后重试', 503), { status: 503 })
  }
  const inserted = []
  try {
    await client.query('BEGIN')
    await lockProjectTx(client, projectId)
    const existingRows = await client.query('SELECT * FROM tasks WHERE project_id = $1', [projectId])
    const foreign = await client.query('SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND project_id <> $2', [taskInputs.map(t => t.id), projectId])
    if (foreign.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('任务 ID 属于其他项目，当前修改仍保留', 409), { status: 409 })
    }
    if (taskInputs.some(t => typeof t.name !== 'string' || !t.name.trim())) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('任务名称不能为空，当前修改仍保留', 400), { status: 400 })
    }
    const existingById = new Map(existingRows.rows.map(t => [t.id, t]))
    const hierarchy = planSubmittedHierarchy(existingRows.rows, taskInputs.map(t => {
      const old = existingById.get(t.id)
      // A replayed create must not undo a later successful parent move.
      return old && !old.is_deleted ? { ...t, parent_id: old.parent_id } : t
    }))
    hierarchyRepairs = hierarchy.repairs

    for (const task of taskInputs) {
      const { id, task_code, name, parent_id, assignee, start_date, end_date, duration, duration_unit,
              percent_done, is_milestone, note, order_index, auto_schedule,
              constraint_type, constraint_date, deadline, status, rollup, inactive,
              project_boundary, baseline_end_date } = task as Record<string, unknown>
      if (!name) continue

      // 客户端可提供 id / task_code（本地预先生成）。校验客户端 id 不重复。
      const clientId = (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ? id : null
      if (clientId) {
        const existing = await client.query('SELECT * FROM tasks WHERE id = $1', [clientId])
        const saved = existing.rows[0]
        if (saved) {
          if (saved.project_id !== projectId) {
            await client.query('ROLLBACK')
            return NextResponse.json(failure('任务 ID 属于其他项目，当前修改仍保留', 409), { status: 409 })
          }
          // A committed create whose response was lost is safe to replay.
          // Updates to that task must still use PUT; do not duplicate its history.
          inserted.push(saved)
          continue
        }
      }
      let code: string
      if (typeof task_code === 'string' && task_code.trim()) {
        const requestedCode = task_code.trim()
        code = await taskCodeExists(client, projectId, requestedCode)
          ? await nextTaskCode(client, projectId)
          : requestedCode
      } else {
        code = await nextTaskCode(client, projectId)
      }

      // 归一化为 ISO datetime 'YYYY-MM-DDTHH:mm:ss'（分钟级保留时间）
      const normalizeDate = (date: unknown): string | null => {
        if (!date) return null
        if (typeof date === 'string') {
          const m = date.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
          if (!m) return date
          const hh = m[2] ?? '00', mm = m[3] ?? '00', ss = m[4] ?? '00'
          return `${m[1]}T${hh}:${mm}:${ss}`
        }
        if (date instanceof Date) {
          const pad = (n: number) => String(n).padStart(2, '0')
          return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}` +
                 `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        }
        return null
      }

      let normalizedStart = normalizeDate(start_date)
      let normalizedEnd = normalizeDate(end_date)
      let normalizedDuration: number | null
      try {
        normalizedDuration = normalizeDurationMinutes(duration, normalizedStart, normalizedEnd)
      } catch (err) {
        await client.query('ROLLBACK')
        return NextResponse.json(
          failure(err instanceof Error ? err.message : '工期格式错误', 400),
          { status: 400 },
        )
      }

      // 限制开始日期不早于项目开始日期
      {
        const projRes = await client.query('SELECT start_date FROM projects WHERE id = $1', [projectId])
        const projStart = projRes.rows[0]?.start_date ? toDateStr(projRes.rows[0].start_date) : null
        if (!submittedPlan && projStart && normalizedStart && normalizedStart < projStart) {
          const dur = normalizedDuration ?? 0
          normalizedStart = projStart
          if (is_milestone) {
            normalizedEnd = projStart
          } else {
            normalizedEnd = addDaysStr(projStart, dur)
          }
        }
      }

      const r = await client.query(
        `INSERT INTO tasks
           (id, project_id, parent_id, task_code, name, assignee, start_date, end_date,
            duration, duration_unit, percent_done, is_milestone, note, order_index, auto_schedule,
            constraint_type, constraint_date, deadline, status, rollup, inactive,
            project_boundary, baseline_end_date)
         VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [clientId, projectId, null, code, name,
         assignee ?? null, normalizedStart, normalizedEnd,
         normalizedDuration, duration_unit ?? 'day',
         percent_done ?? 0, is_milestone ?? false, note ?? null, order_index ?? 0, auto_schedule !== undefined ? auto_schedule : true,
         constraint_type ?? 'asap', normalizeDate(constraint_date), normalizeDate(deadline),
         status ?? null, rollup ?? false, inactive ?? false,
         project_boundary ?? 'ask', normalizeDate(baseline_end_date)]
      )
      const newTask = r.rows[0]
      inserted.push(newTask)

      await addLifecycle(client, {
        taskId: newTask.id, taskCode: code, projectId,
        userId: auth.value.userId, event_type: 'created',
        description: `创建任务「${name}」（${code}）`,
        reason: (task as Record<string, unknown>)._reason,
      })
    }

    // All IDs now exist; apply the final graph and revive explicitly retained
    // same-project records before any summary handling.
    await persistSubmittedHierarchy(client, projectId, auth.value.userId, existingRows.rows, hierarchy)
    if (!submittedPlan) {
      await updateSummaryTasksDates(client, projectId)
      await snapTasksToDayLevel(client, projectId)
    }
    const saved = await client.query('SELECT * FROM tasks WHERE project_id = $1 AND id = ANY($2::uuid[])', [projectId, inserted.map(t => t.id)])
    const savedById = new Map(saved.rows.map(t => [t.id, t]))
    for (let i = 0; i < inserted.length; i++) inserted[i] = savedById.get(inserted[i].id) ?? inserted[i]

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('POST /api/tasks error:', msg)
    return NextResponse.json(failure('创建任务失败: ' + msg, 500), { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json({ ...success(inserted), warnings: hierarchyRepairs }, { status: 201 })
}

// ── PUT ───────────────────────────────────────────────────────────────────

const normalizeDate = (date: unknown): string | null => {
  if (!date) return null
  if (typeof date === 'string') {
    const m = date.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
    if (!m) return date
    const hh = m[2] ?? '00', mm = m[3] ?? '00', ss = m[4] ?? '00'
    return `${m[1]}T${hh}:${mm}:${ss}`
  }
  if (date instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}` +
           `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
  return null
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  let owned: boolean
  try {
    owned = await hasProjectAccess(projectId, auth.value)
  } catch (err) {
    console.error('PUT /api/tasks verifyOwnership error:', err)
    return NextResponse.json(failure('数据库连接失败', 500), { status: 500 })
  }
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('请求体解析失败', 400), { status: 400 })
  }
  const submittedPlan = req.headers.get('x-gantt-confirmed-save') === '1' || isSubmittedTaskBatch(body)
  let taskInputs: Record<string, any>[] = (Array.isArray(body) ? body : [body]).filter(t => t && typeof t === 'object')
  if (taskInputs.some(t => !isUuid(t.id))) return NextResponse.json(failure('无效的任务 ID，当前修改仍保留', 400), { status: 400 })
  let hierarchyRepairs: HierarchyRepair[] = []

  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    console.error('PUT /api/tasks pool.connect error:', err)
    return NextResponse.json(failure('数据库连接池繁忙，请稍后重试', 503), { status: 503 })
  }
  const updated: TaskLike[] = []
  try {
    await client.query('BEGIN')
    await lockProjectTx(client, projectId)

    // 查询项目的 status_date 用于判定"历史修改"，并取粒度用于日志单位
    const projRes = await client.query(
      'SELECT status_date, time_granularity FROM projects WHERE id = $1',
      [projectId],
    )
    const projIsMinute = projRes.rows[0]?.time_granularity === 'minute'
    const projStatusDate: string | null = projRes.rows[0]?.status_date
      ? toDateStr(projRes.rows[0].status_date as string)
      : null
    const auditStatusDate = projIsMinute
      ? projStatusDate
      : (projStatusDate ? projStatusDate.slice(0, 10) : null)

    const inputIds = taskInputs.map(t => t.id as string)
    const existingRows = await client.query('SELECT * FROM tasks WHERE project_id = $1', [projectId])
    const oldMap = new Map<string, Record<string, any>>(existingRows.rows.map(t => [t.id, t]))
    const missingIds = inputIds.filter(id => !oldMap.has(id))
    if (missingIds.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('部分任务已不存在于当前项目，请直接重试以按当前提交重建；未保存修改仍保留', 404), { status: 404 })
    }
    const hierarchy = planSubmittedHierarchy(existingRows.rows, taskInputs as HierarchyTask[])
    if (!submittedPlan && hierarchy.repairs.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('父任务必须属于当前项目且不能形成循环', 400), { status: 400 })
    }
    hierarchyRepairs = hierarchy.repairs
    const parents = new Map(hierarchy.parents.map(t => [t.id, t.parent_id]))
    taskInputs = taskInputs.map(t => ({ ...t, parent_id: parents.get(t.id) ?? null }))
    // Resolve parent reversals as one graph, not against intermediate old rows.
    await persistSubmittedHierarchy(client, projectId, auth.value.userId, existingRows.rows, hierarchy)

    // Collect lifecycle events for batch insert at the end
    const lifecycleEvents: LifecycleInput[] = []

    // Collect parent IDs that need name lookups for lifecycle descriptions
    const parentLookupIds = new Set<string>()

    // 回溯修改审计日志（对 end_date ≤ 项目状态日期 的"历史任务"做关键字段修改时记录）
    const auditEntries: Array<{
      taskId: string; field: string
      oldValue: string | null; newValue: string | null
      reason: string | null
    }> = []
    const AUDIT_FIELDS = ['name', 'start_date', 'end_date', 'duration', 'percent_done'] as const

    for (const task of taskInputs) {
      const { id } = task as { id: string }
      if (!id) continue

      const old = oldMap.get(id)
      if (!old) continue

      const hasParentKey = 'parent_id' in task
      const hasAssigneeKey = 'assignee' in task

      // ── 里程碑强制约束：工期=0, end_date=start_date, percent_done=100 ──
      const taskRec = task as Record<string, unknown>
      const isMilestone = taskRec.is_milestone ?? old.is_milestone
      if (isMilestone) {
        taskRec.duration = 0
        taskRec.percent_done = 100
        const sd = normalizeDate(taskRec.start_date) ?? toDateStr(old.start_date as string)
        if (sd) taskRec.end_date = sd
      }

      try {
        if ('duration' in taskRec) {
          taskRec.duration = normalizeDurationMinutes(
            taskRec.duration,
            (taskRec.start_date as string | Date | null | undefined) ?? (old.start_date as string | Date | null),
            (taskRec.end_date as string | Date | null | undefined) ?? (old.end_date as string | Date | null),
          )
        }
      } catch (err) {
        await client.query('ROLLBACK')
        return NextResponse.json({
          ok: false,
          errors: [{
            taskId: id,
            field: 'duration',
            message: err instanceof Error ? err.message : '工期格式错误',
          }],
        }, { status: 400 })
      }

      // ── 校验字段合法性 ──────────────────────────────────────────────────
      {
        const errors: Array<{ taskId: string; field: string; message: string }> = []
        const tName = (taskRec.name as string | undefined) ?? old.name as string
        if (typeof tName === 'string' && tName.trim() === '') {
          errors.push({ taskId: id, field: 'name', message: '任务名称不能为空' })
        }
        const tDur = (taskRec.duration as number | undefined) ?? old.duration as number
        if (tDur != null && tDur < 0) {
          errors.push({ taskId: id, field: 'duration', message: '工期不能为负数' })
        }
        const tPct = (taskRec.percent_done as number | undefined) ?? old.percent_done as number
        if (tPct != null && (tPct < 0 || tPct > 100)) {
          errors.push({ taskId: id, field: 'percent_done', message: '完成度必须在 0~100 之间' })
        }
        const tStart = normalizeDate(taskRec.start_date) ?? toDateStr(old.start_date as string)
        const tEnd   = normalizeDate(taskRec.end_date)   ?? toDateStr(old.end_date as string)
        if (tStart && tEnd && tStart > tEnd) {
          errors.push({ taskId: id, field: 'start_date', message: '开始日期不能晚于结束日期' })
        }
        if (errors.length > 0) {
          await client.query('ROLLBACK')
          return NextResponse.json({ ok: false, errors }, { status: 400 })
        }
      }

      const hasAutoScheduleKey = 'auto_schedule' in task
      const t = task as Record<string, unknown>
      const hasCT = 'constraint_type' in task
      const hasCD = 'constraint_date' in task
      const hasDL = 'deadline' in task
      const hasStatus = 'status' in task
      const hasRollup = 'rollup' in task
      const hasInactive = 'inactive' in task
      const hasPB = 'project_boundary' in task
      const hasBE = 'baseline_end_date' in task
      const r = await client.query(
        `UPDATE tasks SET
           name         = COALESCE($1, name),
           parent_id    = CASE WHEN $13 THEN $2 ELSE parent_id END,
           assignee     = CASE WHEN $14 THEN $3 ELSE assignee END,
           start_date   = CASE WHEN $34 THEN $4 ELSE start_date END,
           end_date     = CASE WHEN $35 THEN $5 ELSE end_date END,
           duration     = CASE WHEN $36 THEN $6 ELSE duration END,
           duration_unit= COALESCE($7, duration_unit),
           percent_done = COALESCE($8, percent_done),
           is_milestone = COALESCE($9, is_milestone),
           note         = CASE WHEN $37 THEN $10 ELSE note END,
           order_index  = COALESCE($11, order_index),
           auto_schedule= CASE WHEN $16 THEN $17 ELSE auto_schedule END,
           constraint_type = CASE WHEN $18 THEN $19 ELSE constraint_type END,
           constraint_date = CASE WHEN $20 THEN $21 ELSE constraint_date END,
           status          = CASE WHEN $22 THEN $23 ELSE status END,
           rollup          = CASE WHEN $24 THEN $25 ELSE rollup END,
           inactive        = CASE WHEN $26 THEN $27 ELSE inactive END,
           project_boundary= CASE WHEN $28 THEN $29 ELSE project_boundary END,
           baseline_end_date = CASE WHEN $30 THEN $31 ELSE baseline_end_date END,
           deadline        = CASE WHEN $32 THEN $33 ELSE deadline END,
           updated_at   = NOW()
         WHERE id = $12 AND project_id = $15
         RETURNING *`,
        [
          t.name ?? null,
          t.parent_id ?? null,
          t.assignee ?? null,
          normalizeDate(t.start_date),
          normalizeDate(t.end_date),
          t.duration ?? null,
          t.duration_unit ?? null,
          t.percent_done ?? null,
          t.is_milestone ?? null,
          t.note ?? null,
          t.order_index ?? null,
          id, hasParentKey, hasAssigneeKey, projectId,
          hasAutoScheduleKey, t.auto_schedule ?? true,
          hasCT, (t.constraint_type as string | null) ?? null,
          hasCD, normalizeDate(t.constraint_date),
          hasStatus, (t.status as string | null) ?? null,
          hasRollup, (t.rollup as boolean | null) ?? false,
          hasInactive, (t.inactive as boolean | null) ?? false,
          hasPB, (t.project_boundary as string | null) ?? 'ask',
          hasBE, normalizeDate(t.baseline_end_date),
          hasDL, normalizeDate(t.deadline),
          Object.hasOwn(t, 'start_date'), Object.hasOwn(t, 'end_date'), Object.hasOwn(t, 'duration'), Object.hasOwn(t, 'note'),
        ]
      )
      if (!r.rows[0]) continue
      const cur = r.rows[0]
      updated.push(cur)

      // ── 审计：判定是否为"历史任务"回溯修改 ─────────────────────────────
      const oldEndRaw = toDateStr(old.end_date as string)
      const oldEndStr = projIsMinute ? oldEndRaw : (oldEndRaw ? oldEndRaw.slice(0, 10) : null)
      const statusCutoff = projIsMinute ? projStatusDate : auditStatusDate
      const isHistorical = statusCutoff && oldEndStr && oldEndStr <= statusCutoff
      if (isHistorical) {
        const reason = normalizeChangeReason(t._reason)
        for (const f of AUDIT_FIELDS) {
          if (!(f in task)) continue
          const norm = (v: unknown) => {
            if (v == null) return null
            if (f === 'start_date' || f === 'end_date') {
              const dt = toDateStr(v as string)
              return projIsMinute ? dt : (dt ? dt.slice(0, 10) : null)
            }
            return String(v)
          }
          const oldV = norm(old[f])
          const newV = norm(cur[f])
          if (oldV !== newV) {
            auditEntries.push({ taskId: id, field: f, oldValue: oldV, newValue: newV, reason })
          }
        }
      }

      const code: string = cur.task_code ?? old.task_code ?? id.slice(0, 8)

      // ── Detect position move (order_index or parent_id changed) ────────
      const parentChanged = hasParentKey && String(old.parent_id ?? '') !== String(cur.parent_id ?? '')
      const orderChanged  = (task as Record<string, unknown>).order_index !== undefined
                         && old.order_index !== cur.order_index

      if (parentChanged || orderChanged) {
        if (parentChanged && cur.parent_id) {
          parentLookupIds.add(cur.parent_id)
        }
        // Defer lifecycle event — parent name lookup done later in batch
        // Store move info for post-processing
        (cur as Record<string, unknown>)._moveInfo = {
          parentChanged, orderChanged, old, code, reason: normalizeChangeReason(t._reason),
        }

        // ── When parent_id changes, update both old and new parent task dates ────────
        if (parentChanged && !submittedPlan) {
          const collected: TaskLike[] = []
          if (old.parent_id) {
            await updateSummaryTaskDateRecursive(client, old.parent_id as string, collected)
          }
          if (cur.parent_id) {
            await updateSummaryTaskDateRecursive(client, cur.parent_id, collected)
          }
          for (const u of collected) {
            if (!updated.some((x: TaskLike) => x.id === u.id)) updated.push(u)
          }
        }
      }

      // ── Detect field updates (collect for batch lifecycle insert) ───────
      const COMPARE_FIELDS = ['name','start_date','end_date','duration','assignee','is_milestone','note']
      let dateChanged = false
      for (const f of COMPARE_FIELDS) {
        if (!(f in task)) continue
        // 分钟级比较：保留 HH:mm，避免同日不同时间被误判为"无变更"。
        // 日期字段如果是 pg 返回的 Date 对象，先取本地 YYYY-MM-DDTHH:mm 再比较，
        // 否则 String(Date) 会变成 "Thu May 21 2026 16:00:00 GMT+0800" 让比较失效。
        const norm = (v: unknown) => {
          if (v === null || v === undefined) return ''
          if (v instanceof Date) {
            if (isNaN(v.getTime())) return ''
            const pad = (n: number) => String(n).padStart(2, '0')
            return `${v.getFullYear()}-${pad(v.getMonth()+1)}-${pad(v.getDate())}` +
                   `T${pad(v.getHours())}:${pad(v.getMinutes())}`
          }
          const s = String(v)
          const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/)
          return m ? `${m[1]}${m[2] ? `T${m[2]}` : ''}` : s
        }
        const ov = norm(old[f])
        const nv = norm(cur[f])
        if (ov === nv) continue
        const label = FIELD_LABELS[f] ?? f
        const ovStr = fmtFieldVal(f, old[f], { isMinute: projIsMinute })
        const nvStr = fmtFieldVal(f, cur[f], { isMinute: projIsMinute })
        let desc: string
        if (f === 'duration') {
          const diffMins = Number(cur[f] ?? 0) - Number(old[f] ?? 0)
          // 天级项目：按天显示；分钟级：按分钟显示
          const unit = projIsMinute ? '分钟' : '天'
          const diffShown = projIsMinute ? diffMins : Math.round(diffMins / 1440)
          desc = diffMins > 0
            ? `任务「${cur.name}」（${code}）工期延长 ${diffShown} ${unit}（${ovStr} → ${nvStr}）`
            : `任务「${cur.name}」（${code}）工期缩短 ${Math.abs(diffShown)} ${unit}（${ovStr} → ${nvStr}）`
        } else if (f === 'name') {
          desc = `任务（${code}）重命名：「${ovStr}」→「${nvStr}」`
        } else {
          desc = `任务「${cur.name}」（${code}）${label}：${ovStr} → ${nvStr}`
        }
        lifecycleEvents.push({
          taskId: id, taskCode: code, projectId, userId: auth.value.userId,
          event_type: 'updated', field_name: f,
          old_value: ovStr, new_value: nvStr, description: desc, reason: t._reason,
        })

        if (f === 'start_date' || f === 'end_date') dateChanged = true
      }

      // ── When task date changes, update parent summary task dates (once) ─
      if (!submittedPlan && dateChanged && cur.parent_id) {
        const collected: TaskLike[] = []
        await updateSummaryTaskDateRecursive(client, cur.parent_id, collected)
        for (const u of collected) {
          if (!updated.some((x: TaskLike) => x.id === u.id)) updated.push(u)
        }
      }
    }

    // ── Batch lookup parent names for move lifecycle events ───────────────
    const parentNameMap = new Map<string, { name: string; task_code: string }>()
    if (parentLookupIds.size > 0) {
      const lookupArr = [...parentLookupIds]
      const ph = lookupArr.map((_: string, i: number) => `$${i + 1}`).join(',')
      const parentRes = await client.query(
        `SELECT id, name, task_code FROM tasks WHERE id IN (${ph})`,
        lookupArr
      )
      for (const r of parentRes.rows) parentNameMap.set(r.id, { name: r.name, task_code: r.task_code })
    }

    // ── Generate move lifecycle events with resolved parent names ─────────
    for (const cur of updated) {
      const moveInfo = (cur as Record<string, unknown>)._moveInfo as {
        parentChanged: boolean; orderChanged: boolean
        old: Record<string, unknown>; code: string; reason: string | null
      } | undefined
      if (!moveInfo) continue
      delete (cur as Record<string, unknown>)._moveInfo

      const { parentChanged, old, code } = moveInfo
      let desc: string
      if (parentChanged && cur.parent_id === null) {
        desc = `任务「${(cur as Record<string, unknown>).name}」（${code}）升级为顶级任务`
      } else if (parentChanged) {
        const pInfo = parentNameMap.get(cur.parent_id as string)
        const pName = pInfo?.name ?? cur.parent_id
        const pCode = pInfo?.task_code ?? ''
        desc = `任务「${(cur as Record<string, unknown>).name}」（${code}）移至子任务，父级：「${pName}」（${pCode}）`
      } else {
        const curRec = cur as Record<string, unknown>
        const dir = Number(curRec.order_index) < Number(old.order_index) ? '上移' : '下移'
        desc = `任务「${curRec.name}」（${code}）${dir}（排序 ${old.order_index} → ${curRec.order_index}）`
      }
      const curRec = cur as Record<string, unknown>
      lifecycleEvents.push({
        taskId: cur.id, taskCode: code, projectId, userId: auth.value.userId,
        event_type: 'moved',
        field_name: parentChanged ? 'parent_id' : 'order_index',
        old_value: parentChanged ? String(old.parent_id ?? '顶级') : String(old.order_index),
        new_value: parentChanged ? String(curRec.parent_id ?? '顶级') : String(curRec.order_index),
        description: desc, reason: moveInfo.reason,
      })
    }

    // ── Batch insert all lifecycle events ─────────────────────────────────
    await addLifecycleBatch(client, lifecycleEvents)

    // FS 依赖自动级联：确保后继任务开始日期 >= 前置任务结束日期 + lag
    const cascadedIds = submittedPlan ? [] : await cascadeDependencies(client, projectId)
    if (cascadedIds.length > 0) {
      const ph = cascadedIds.map((_, i) => `$${i + 2}`).join(',')
      const cascadedRows = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
        [projectId, ...cascadedIds]
      )
      cascadedRows.rows.forEach((r: TaskLike) => {
        if (!updated.some((u: TaskLike) => u.id === r.id)) updated.push(r)
      })
    }

    // 更新摘要任务的时间范围：摘要任务的起止时间应该与所有子任务的范围一致
    const summaryUpdated = submittedPlan ? [] : await updateSummaryTasksDates(client, projectId)
    if (summaryUpdated.length > 0) {
      summaryUpdated.forEach(r => {
        if (!updated.some((u: TaskLike) => u.id === r.id)) updated.push(r)
      })
    }

    // 天级项目：把级联/摘要算出的非整天时间统一 snap 到 00:00
    const snappedIds = submittedPlan ? [] : await snapTasksToDayLevel(client, projectId)
    if (snappedIds.length > 0) {
      const ph = snappedIds.map((_, i) => `$${i + 2}`).join(',')
      const snappedRows = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph})`,
        [projectId, ...snappedIds]
      )
      snappedRows.rows.forEach((r: TaskLike) => {
        const idx = updated.findIndex((u: TaskLike) => u.id === r.id)
        if (idx >= 0) updated[idx] = r
        else updated.push(r)
      })
    }

    // 确保返回完整的任务对象（摘要任务更新可能只包含部分字段）
    const partialIds = updated
      .filter((u: TaskLike) => !('project_id' in u))
      .map((u: TaskLike) => u.id)
    if (partialIds.length > 0) {
      const ph = partialIds.map((_: string, i: number) => `$${i + 1}`).join(',')
      const fullRows = await client.query(
        `SELECT * FROM tasks WHERE id IN (${ph})`,
        partialIds
      )
      const fullMap = new Map(fullRows.rows.map((r: TaskLike) => [r.id, r]))
      for (let i = 0; i < updated.length; i++) {
        const full = fullMap.get(updated[i].id)
        if (full) updated[i] = full
      }
    }

    // Cascading and summary recalculation may update a row already present in
    // `updated`; return its final database value instead of the pre-cascade copy.
    const updatedIds = [...new Set(updated.map((task: TaskLike) => task.id))]
    if (updatedIds.length > 0) {
      const finalRows = await client.query(
        'SELECT * FROM tasks WHERE project_id = $1 AND id = ANY($2::uuid[]) AND is_deleted = false',
        [projectId, updatedIds],
      )
      updated.splice(0, updated.length, ...finalRows.rows)
    }

    // 审计日志批量插入
    if (auditEntries.length > 0) {
      const vals: unknown[] = []
      const rows: string[] = []
      auditEntries.forEach((e, i) => {
        const b = i * 8
        rows.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`)
        vals.push(projectId, e.taskId, auditStatusDate, e.field, e.oldValue, e.newValue, e.reason, auth.value.userId)
      })
      await client.query(
        `INSERT INTO task_change_log
           (project_id, task_id, status_date_at_change, field, old_value, new_value, reason, changed_by)
         VALUES ${rows.join(',')}`,
        vals,
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('PUT /api/tasks error:', msg)
    return NextResponse.json(failure('更新任务失败: ' + msg, 500), { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json({ ...success(updated), warnings: hierarchyRepairs })
}

// ── DELETE (soft) ─────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  const owned = await hasProjectAccess(projectId, auth.value)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  let body: { ids?: string[]; id?: string; reasons?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('请求体解析失败', 400), { status: 400 })
  }
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [body.id!]
  if (!ids.length || ids.some(id => !isUuid(id))) return NextResponse.json(failure('无效的任务 ID', 400), { status: 400 })

  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    console.error('DELETE /api/tasks pool.connect error:', err)
    return NextResponse.json(failure('数据库连接池繁忙，请稍后重试', 503), { status: 503 })
  }
  try {
    await client.query('BEGIN')
    await lockProjectTx(client, projectId)

    // Collect all descendants recursively for cascade soft-delete
    const allIds = new Set<string>(ids)
    let frontier = Array.isArray(body.ids) ? [] : [...ids]
    while (frontier.length) {
      const ph = frontier.map((_, i) => `$${i + 1}`).join(',')
      const children = await client.query(
        `SELECT id FROM tasks WHERE parent_id IN (${ph}) AND project_id = $${frontier.length + 1} AND is_deleted = false`,
        [...frontier, projectId]
      )
      const childIds = children.rows.map((r: { id: string }) => r.id).filter((id: string) => !allIds.has(id))
      childIds.forEach((id: string) => allIds.add(id))
      frontier = childIds
    }

    const allIdArr = [...allIds]
    const ph = allIdArr.map((_, i) => `$${i + 2}`).join(',')

    // Fetch tasks for lifecycle before soft-deleting
    const toDelete = await client.query(
      `SELECT id, task_code, name FROM tasks WHERE project_id = $1 AND id IN (${ph}) AND is_deleted = false`,
      [projectId, ...allIdArr]
    )

    // Soft-delete
    await client.query(
      `UPDATE tasks SET is_deleted = true, deleted_at = NOW()
       WHERE project_id = $1 AND id IN (${ph}) AND is_deleted = false`,
      [projectId, ...allIdArr]
    )

    // Retained children must not vanish just because the old parent is removed.
    const retained = await client.query(`WITH children AS (
      SELECT id, parent_id FROM tasks WHERE project_id = $1 AND is_deleted = false AND parent_id = ANY($2::uuid[])
    ) UPDATE tasks t SET parent_id = NULL, updated_at = NOW() FROM children c WHERE t.id = c.id
      RETURNING t.id, t.task_code, t.name, c.parent_id AS old_parent_id`, [projectId, allIdArr])
    await addLifecycleBatch(client, retained.rows.map(t => ({ taskId: t.id, taskCode: t.task_code ?? t.id,
      projectId, userId: auth.value.userId, event_type: 'moved', field_name: 'parent_id',
      old_value: t.old_parent_id, new_value: null,
      description: `删除旧父任务时保留任务「${t.name}」，暂列为顶级任务，后续提交按用户指定父级保存`,
    })))
    if (!Array.isArray(body.ids)) {
      await collapseDeletedTaskSuccessors(client, projectId, allIdArr)
      await updateSummaryTasksDates(client, projectId)
    }

    // Lifecycle events
    for (const t of toDelete.rows) {
      await addLifecycle(client, {
        taskId: t.id, taskCode: t.task_code ?? t.id.slice(0, 8),
        projectId, userId: auth.value.userId,
        event_type: 'deleted',
        reason: body.reasons?.[t.id],
        description: `删除任务「${t.name}」（${t.task_code ?? ''}）`,
      })
    }

    await client.query('COMMIT')
    return NextResponse.json(success({ deleted: allIdArr }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('DELETE /api/tasks error:', msg)
    return NextResponse.json(failure('删除任务失败: ' + msg, 500), { status: 500 })
  } finally {
    client.release()
  }
}
