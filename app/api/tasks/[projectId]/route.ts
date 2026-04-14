import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import {
  type TaskLike,
  toDateStr, addDaysStr, diffDaysStr,
  cascadeDependencies, updateSummaryTasksDates, updateSummaryTaskDateRecursive,
} from '@/lib/scheduling'

type Params = { params: Promise<{ projectId: string }> }

async function lockProjectTx(client: PoolClient, projectId: string): Promise<void> {
  await client.query('SET LOCAL lock_timeout = \'10s\'')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])
}

async function verifyProjectOwnership(projectId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  )
  return result.rows.length > 0
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

// 日期工具函数、级联、摘要任务更新 → 统一从 @/lib/scheduling 导入


// ── GET ───────────────────────────────────────────────────────────────────
// Read-only: 加载图表时不要持锁、不要级联控写，避免与 PUT/其它会话竞争导致 lock_timeout，
// 前端收到非 ok 后静默不写入 Redux，界面会一直像「空项目」。
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  if (auth.value.role !== 'view') {
    let owned: boolean
    try {
      owned = await verifyProjectOwnership(projectId, auth.value.userId)
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

  const allTasks = tasksRes.rows
  const allDeps = depsRes.rows
  const parentIds = new Set(allTasks.filter((t: { parent_id: string | null }) => t.parent_id).map((t: { parent_id: string }) => t.parent_id))

  // 检查依赖级联和摘要任务是否需要修正
  {
    let needsFix = false
    // 检查依赖级联
    const taskMap = new Map<string, { start: string; end: string; dur: number; auto: boolean; parent_id: string | null }>()
    for (const t of allTasks) {
      taskMap.set(t.id, { start: toDateStr(t.start_date) ?? '', end: toDateStr(t.end_date) ?? '', dur: t.duration ?? 0, auto: t.auto_schedule !== false, parent_id: t.parent_id })
    }
    // 判断 ancestorId 是否是 taskId 的祖先
    const isAnc = (ancestorId: string, taskId: string): boolean => {
      let cur = taskMap.get(taskId); const visited = new Set<string>()
      while (cur?.parent_id) { if (cur.parent_id === ancestorId) return true; if (visited.has(cur.parent_id)) break; visited.add(cur.parent_id); cur = taskMap.get(cur.parent_id) }
      return false
    }
    for (const d of allDeps) {
      // 跳过父子关系的依赖
      if (isAnc(d.from_task_id, d.to_task_id) || isAnc(d.to_task_id, d.from_task_id)) continue
      const from = taskMap.get(d.from_task_id)
      const to = taskMap.get(d.to_task_id)
      if (!from?.start || !from?.end || !to?.start || !to?.end || !to.auto) continue
      const depType = d.type ?? 2
      let rs: string | null = null
      if (depType === 2)      rs = addDaysStr(from.end, d.lag ?? 0)
      else if (depType === 0) rs = addDaysStr(from.start, d.lag ?? 0)
      else if (depType === 3) rs = addDaysStr(from.end, (d.lag ?? 0) - to.dur)
      else if (depType === 1) rs = addDaysStr(from.start, (d.lag ?? 0) - to.dur)
      if (rs && rs !== to.start) { needsFix = true; break }
    }
    // 检查摘要任务
    if (!needsFix) {
      for (const pid of parentIds) {
        const parent = allTasks.find((t: { id: string }) => t.id === pid)
        if (!parent) continue
        const children = allTasks.filter((t: { parent_id: string | null }) => t.parent_id === pid)
        const starts = children.map((c: { start_date: string | null }) => toDateStr(c.start_date)).filter(Boolean) as string[]
        const ends = children.map((c: { end_date: string | null }) => toDateStr(c.end_date)).filter(Boolean) as string[]
        if (starts.length === 0 || ends.length === 0) continue
        if (toDateStr(parent.start_date) !== starts.sort()[0] || toDateStr(parent.end_date) !== ends.sort().reverse()[0]) {
          needsFix = true; break
        }
      }
    }
    if (needsFix) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await cascadeDependencies(client, projectId)
        await updateSummaryTasksDates(client, projectId)
        await client.query('COMMIT')
        const refreshRes = await pool.query(
          'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index ASC',
          [projectId]
        )
        allTasks.length = 0
        allTasks.push(...refreshRes.rows)
      } catch {
        await client.query('ROLLBACK').catch(() => {})
      } finally {
        client.release()
      }
    }
  }

  return NextResponse.json(success({ tasks: allTasks, dependencies: allDeps }))
}

// ── POST ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('请求体解析失败', 400), { status: 400 })
  }
  const taskInputs = Array.isArray(body) ? body : [body]

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
    for (const task of taskInputs) {
      const { name, parent_id, assignee, start_date, end_date, duration, duration_unit,
              percent_done, is_milestone, note, order_index, auto_schedule } = task as Record<string, unknown>
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

      let normalizedStart = normalizeDate(start_date)
      let normalizedEnd = normalizeDate(end_date)

      // 限制开始日期不早于项目开始日期
      {
        const projRes = await client.query('SELECT start_date FROM projects WHERE id = $1', [projectId])
        const projStart = projRes.rows[0]?.start_date ? toDateStr(projRes.rows[0].start_date) : null
        if (projStart && normalizedStart && normalizedStart < projStart) {
          const dur = (duration as number) ?? 0
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
           (project_id, parent_id, task_code, name, assignee, start_date, end_date,
            duration, duration_unit, percent_done, is_milestone, note, order_index, auto_schedule, constraint_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [projectId, parent_id ?? null, code, name,
         assignee ?? null, normalizedStart, normalizedEnd,
         duration ?? null, duration_unit ?? 'day',
         percent_done ?? 0, is_milestone ?? false, note ?? null, order_index ?? 0, auto_schedule !== undefined ? auto_schedule : true,
         'asap']
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
    await client.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('POST /api/tasks error:', msg)
    return NextResponse.json(failure('创建任务失败: ' + msg, 500), { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json(success(inserted), { status: 201 })
}

// ── PUT ───────────────────────────────────────────────────────────────────

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

// Batch insert lifecycle events in one query
async function addLifecycleBatch(
  client: PoolClient,
  events: Array<{
    taskId: string; taskCode: string; projectId: string; userId: string
    event_type: string; field_name?: string | null
    old_value?: string | null; new_value?: string | null
    description: string
  }>
) {
  if (events.length === 0) return
  const values: unknown[] = []
  const rows: string[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const off = i * 9
    rows.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9})`)
    values.push(e.taskId, e.taskCode, e.projectId, e.event_type,
                e.field_name ?? null, e.old_value ?? null, e.new_value ?? null,
                e.description, e.userId)
  }
  await client.query(
    `INSERT INTO task_lifecycle
       (task_id, task_code, project_id, event_type, field_name, old_value, new_value, description, created_by)
     VALUES ${rows.join(',')}`,
    values
  )
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  let owned: boolean
  try {
    owned = await verifyProjectOwnership(projectId, auth.value.userId)
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
  const taskInputs = Array.isArray(body) ? body : [body]

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

    // 查询项目的 status_date 用于判定"历史修改"
    const projRes = await client.query('SELECT status_date FROM projects WHERE id = $1', [projectId])
    const projStatusDate: string | null = projRes.rows[0]?.status_date
      ? toDateStr(projRes.rows[0].status_date as string)
      : null

    // ── Batch fetch all old tasks in one query ────────────────────────────
    const inputIds = taskInputs.map((t: Record<string, unknown>) => t.id as string).filter(Boolean)
    const oldMap = new Map<string, Record<string, unknown>>()
    if (inputIds.length > 0) {
      const ph = inputIds.map((_: string, i: number) => `$${i + 2}`).join(',')
      const prevRes = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND id IN (${ph}) AND is_deleted = false`,
        [projectId, ...inputIds]
      )
      for (const row of prevRes.rows) oldMap.set(row.id, row)
    }

    // Collect lifecycle events for batch insert at the end
    const lifecycleEvents: Array<{
      taskId: string; taskCode: string; projectId: string; userId: string
      event_type: string; field_name?: string | null
      old_value?: string | null; new_value?: string | null
      description: string
    }> = []

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
          client.release()
          return NextResponse.json({ ok: false, errors }, { status: 400 })
        }
      }

      const hasAutoScheduleKey = 'auto_schedule' in task
      const t = task as Record<string, unknown>
      const hasCT = 'constraint_type' in task
      const hasCD = 'constraint_date' in task
      const hasStatus = 'status' in task
      const hasCplx = 'complexity' in task
      const hasRollup = 'rollup' in task
      const hasInactive = 'inactive' in task
      const hasPB = 'project_boundary' in task
      const hasBE = 'baseline_end_date' in task
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
           constraint_type = CASE WHEN $18 THEN $19 ELSE constraint_type END,
           constraint_date = CASE WHEN $20 THEN $21 ELSE constraint_date END,
           status          = CASE WHEN $22 THEN $23 ELSE status END,
           complexity      = CASE WHEN $24 THEN $25 ELSE complexity END,
           rollup          = CASE WHEN $26 THEN $27 ELSE rollup END,
           inactive        = CASE WHEN $28 THEN $29 ELSE inactive END,
           project_boundary= CASE WHEN $30 THEN $31 ELSE project_boundary END,
           baseline_end_date = CASE WHEN $32 THEN $33 ELSE baseline_end_date END,
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
          hasCplx, (t.complexity as number | null) ?? null,
          hasRollup, (t.rollup as boolean | null) ?? false,
          hasInactive, (t.inactive as boolean | null) ?? false,
          hasPB, (t.project_boundary as string | null) ?? 'ask',
          hasBE, normalizeDate(t.baseline_end_date),
        ]
      )
      if (!r.rows[0]) continue
      const cur = r.rows[0]
      updated.push(cur)

      // ── 审计：判定是否为"历史任务"回溯修改 ─────────────────────────────
      const oldEndStr = toDateStr(old.end_date as string)
      const isHistorical = projStatusDate && oldEndStr && oldEndStr <= projStatusDate
      if (isHistorical) {
        const reason = (t._reason as string | undefined) ?? null
        for (const f of AUDIT_FIELDS) {
          if (!(f in task)) continue
          const norm = (v: unknown) => {
            if (v == null) return null
            if (f === 'start_date' || f === 'end_date') return toDateStr(v as string)
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
          parentChanged, orderChanged, old, code,
        }

        // ── When parent_id changes, update both old and new parent task dates ────────
        if (parentChanged) {
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
        lifecycleEvents.push({
          taskId: id, taskCode: code, projectId, userId: auth.value.userId,
          event_type: 'updated', field_name: f,
          old_value: ovStr, new_value: nvStr, description: desc,
        })

        if (f === 'start_date' || f === 'end_date') dateChanged = true
      }

      // ── When task date changes, update parent summary task dates (once) ─
      if (dateChanged && cur.parent_id) {
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
        old: Record<string, unknown>; code: string
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
        description: desc,
      })
    }

    // ── Batch insert all lifecycle events ─────────────────────────────────
    await addLifecycleBatch(client, lifecycleEvents)

    // FS 依赖自动级联：确保后继任务开始日期 >= 前置任务结束日期 + lag
    const cascadedIds = await cascadeDependencies(client, projectId)
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
    const summaryUpdated = await updateSummaryTasksDates(client, projectId)
    if (summaryUpdated.length > 0) {
      summaryUpdated.forEach(r => {
        if (!updated.some((u: TaskLike) => u.id === r.id)) updated.push(r)
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

    // 审计日志批量插入
    if (auditEntries.length > 0) {
      const vals: unknown[] = []
      const rows: string[] = []
      auditEntries.forEach((e, i) => {
        const b = i * 8
        rows.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`)
        vals.push(projectId, e.taskId, projStatusDate, e.field, e.oldValue, e.newValue, e.reason, auth.value.userId)
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

  return NextResponse.json(success(updated))
}

// ── DELETE (soft) ─────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  const owned = await verifyProjectOwnership(projectId, auth.value.userId)
  if (!owned) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  let body: { ids?: string[]; id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('请求体解析失败', 400), { status: 400 })
  }
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [body.id!]
  if (!ids.length) return NextResponse.json(failure('No IDs provided', 400), { status: 400 })

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
    await client.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('DELETE /api/tasks error:', msg)
    return NextResponse.json(failure('删除任务失败: ' + msg, 500), { status: 500 })
  } finally {
    client.release()
  }
}
