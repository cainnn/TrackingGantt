import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'

// ── Human-readable field names ────────────────────────────────────────────
const FIELD_LABELS: Record<string, string> = {
  name:         '任务名称',
  start_date:   '开始日期',
  end_date:     '结束日期',
  duration:     '工期',
  assignee:     '责任人',
  percent_done: '完成度',
  parent_id:    '层级',
  is_milestone: '里程碑',
  note:         '备注',
}

function fmtVal(field: string, val: unknown): string {
  if (val === null || val === undefined || val === '') return '(空)'
  if (field === 'start_date' || field === 'end_date') {
    const s = String(val)
    return s.includes('T') ? s.split('T')[0] : s
  }
  if (field === 'duration') return `${val} 天`
  if (field === 'percent_done') return `${val}%`
  if (field === 'is_milestone') return val ? '是' : '否'
  return String(val)
}

type TaskRow = Record<string, unknown>
type DepRow  = Record<string, unknown>

interface ChangeEntry {
  change_type: string
  task_name:   string | null
  field_name:  string | null
  old_value:   string | null
  new_value:   string | null
  description: string
}

// Compute depth-first flat order (same as client-side), returns ordered task IDs
function getFlatOrder(tasks: TaskRow[]): string[] {
  const kids: Record<string, TaskRow[]> = {}
  for (const t of tasks) {
    const k = (t.parent_id ?? '__root__') as string
    if (!kids[k]) kids[k] = []
    kids[k].push(t)
  }
  const order: string[] = []
  function walk(pid: string | null) {
    const key = pid ?? '__root__'
    ;(kids[key] ?? [])
      .sort((a, b) => (a.order_index as number) - (b.order_index as number))
      .forEach(t => { order.push(t.id as string); walk(t.id as string) })
  }
  walk(null)
  return order
}

function diffSnapshots(
  prevTasks: TaskRow[], prevDeps: DepRow[],
  currTasks: TaskRow[], currDeps: DepRow[],
): ChangeEntry[] {
  const changes: ChangeEntry[] = []

  const prevMap = new Map(prevTasks.map(t => [t.id as string, t]))
  const currMap = new Map(currTasks.map(t => [t.id as string, t]))

  // Added tasks
  for (const t of currTasks) {
    if (!prevMap.has(t.id as string)) {
      changes.push({
        change_type: 'task_add',
        task_name:   t.name as string,
        field_name:  null, old_value: null, new_value: null,
        description: `新增任务「${t.name}」`,
      })
    }
  }

  // Deleted tasks
  for (const t of prevTasks) {
    if (!currMap.has(t.id as string)) {
      changes.push({
        change_type: 'task_delete',
        task_name:   t.name as string,
        field_name:  null, old_value: null, new_value: null,
        description: `删除任务「${t.name}」`,
      })
    }
  }

  // Updated tasks
  const COMPARE_FIELDS = ['name','start_date','end_date','duration','assignee','percent_done','parent_id','is_milestone','note']
  for (const curr of currTasks) {
    const prev = prevMap.get(curr.id as string)
    if (!prev) continue
    for (const f of COMPARE_FIELDS) {
      const pv = prev[f] ?? null
      const cv = curr[f] ?? null
      // Normalise dates to YYYY-MM-DD for comparison
      const norm = (v: unknown) => {
        if (!v) return null
        const s = String(v)
        return s.includes('T') ? s.split('T')[0] : s
      }
      const pvN = (f === 'start_date' || f === 'end_date') ? norm(pv) : pv
      const cvN = (f === 'start_date' || f === 'end_date') ? norm(cv) : cv
      if (String(pvN ?? '') !== String(cvN ?? '')) {
        const label = FIELD_LABELS[f] ?? f
        const pStr  = fmtVal(f, pv)
        const cStr  = fmtVal(f, cv)
        let desc: string
        if (f === 'duration') {
          const diff = Number(cv ?? 0) - Number(pv ?? 0)
          desc = diff > 0
            ? `任务「${curr.name}」工期延长 ${diff} 天（${pStr} → ${cStr}）`
            : `任务「${curr.name}」工期缩短 ${Math.abs(diff)} 天（${pStr} → ${cStr}）`
        } else if (f === 'start_date') {
          desc = `任务「${curr.name}」开始日期从 ${pStr} 改为 ${cStr}`
        } else if (f === 'end_date') {
          desc = `任务「${curr.name}」结束日期从 ${pStr} 改为 ${cStr}`
        } else if (f === 'name') {
          desc = `任务重命名：「${pStr}」→「${cStr}」`
        } else if (f === 'parent_id') {
          desc = cv
            ? `任务「${curr.name}」设为子任务`
            : `任务「${curr.name}」升级为顶级任务`
        } else {
          desc = `任务「${curr.name}」${label}：${pStr} → ${cStr}`
        }
        changes.push({
          change_type: 'task_update',
          task_name:   curr.name as string,
          field_name:  f,
          old_value:   pStr,
          new_value:   cStr,
          description: desc,
        })
      }
    }
  }

  // ── Position changes (reorder / swap) ──────────────────────────────────
  // Only consider tasks present in both versions; ignore added/deleted tasks here
  const bothIds = new Set([...prevMap.keys()].filter(id => currMap.has(id)))

  // Compute flat tree row number restricted to shared tasks only
  // (filtering out added/deleted keeps numbering stable across the two snapshots)
  const prevShared = getFlatOrder(prevTasks).filter(id => bothIds.has(id))
  const currShared = getFlatOrder(currTasks).filter(id => bothIds.has(id))

  const prevPos: Record<string, number> = {}
  const currPos: Record<string, number> = {}
  prevShared.forEach((id, i) => { prevPos[id] = i + 1 })
  currShared.forEach((id, i) => { currPos[id] = i + 1 })

  const moved = [...bothIds].filter(id => prevPos[id] !== currPos[id])

  // Detect pure swaps: A was at p→q, B was at q→p
  const swapped = new Set<string>()
  for (let i = 0; i < moved.length; i++) {
    const idA = moved[i]
    if (swapped.has(idA)) continue
    for (let j = i + 1; j < moved.length; j++) {
      const idB = moved[j]
      if (swapped.has(idB)) continue
      if (prevPos[idA] === currPos[idB] && prevPos[idB] === currPos[idA]) {
        const nameA = currMap.get(idA)!.name as string
        const nameB = currMap.get(idB)!.name as string
        changes.push({
          change_type: 'task_reorder',
          task_name:   nameA,
          field_name:  null,
          old_value:   String(prevPos[idA]),
          new_value:   String(currPos[idA]),
          description: `任务「${nameA}」与「${nameB}」交换了位置（第${prevPos[idA]}行 ↔ 第${prevPos[idB]}行）`,
        })
        swapped.add(idA)
        swapped.add(idB)
        break
      }
    }
  }

  // Remaining non-swap moves
  for (const id of moved) {
    if (swapped.has(id)) continue
    const name = currMap.get(id)!.name as string
    const from = prevPos[id]
    const to   = currPos[id]
    changes.push({
      change_type: 'task_reorder',
      task_name:   name,
      field_name:  null,
      old_value:   String(from),
      new_value:   String(to),
      description: `任务「${name}」${to < from ? '上移' : '下移'}（第${from}行 → 第${to}行）`,
    })
  }

  // Dependencies
  const prevDepSet = new Set(prevDeps.map(d => `${d.from_task_id}→${d.to_task_id}`))
  const currDepSet = new Set(currDeps.map(d => `${d.from_task_id}→${d.to_task_id}`))
  const taskNameMap = new Map(currTasks.map(t => [t.id as string, t.name as string]))
  // fallback to prev names for deleted tasks
  for (const t of prevTasks) if (!taskNameMap.has(t.id as string)) taskNameMap.set(t.id as string, t.name as string)

  for (const d of currDeps) {
    const key = `${d.from_task_id}→${d.to_task_id}`
    if (!prevDepSet.has(key)) {
      const from = taskNameMap.get(d.from_task_id as string) ?? '未知'
      const to   = taskNameMap.get(d.to_task_id   as string) ?? '未知'
      changes.push({
        change_type: 'dep_add',
        task_name: null, field_name: null, old_value: null, new_value: null,
        description: `新增依赖：「${from}」→「${to}」`,
      })
    }
  }
  for (const d of prevDeps) {
    const key = `${d.from_task_id}→${d.to_task_id}`
    if (!currDepSet.has(key)) {
      const from = taskNameMap.get(d.from_task_id as string) ?? '未知'
      const to   = taskNameMap.get(d.to_task_id   as string) ?? '未知'
      changes.push({
        change_type: 'dep_delete',
        task_name: null, field_name: null, old_value: null, new_value: null,
        description: `删除依赖：「${from}」→「${to}」`,
      })
    }
  }

  return changes
}

// GET /api/versions/[projectId] — list versions with change logs
export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId } = await params
  const client = await pool.connect()
  try {
    const proj = await client.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, auth.value.userId],
    )
    if (!proj.rows.length)
      return NextResponse.json({ ok: false, error: 'Not found', code: 404 }, { status: 404 })

    const versRes = await client.query(
      `SELECT v.id, v.project_id, v.version_number, v.created_at,
              u.username AS created_by_name,
              jsonb_array_length(v.snapshot->'tasks') AS task_count
       FROM project_versions v
       LEFT JOIN users u ON u.id = v.created_by
       WHERE v.project_id = $1
       ORDER BY v.version_number DESC`,
      [projectId],
    )

    // Attach change logs to each version
    const versionIds = versRes.rows.map(v => v.id)
    let logsMap: Record<string, unknown[]> = {}
    if (versionIds.length > 0) {
      const logsRes = await client.query(
        `SELECT * FROM change_logs WHERE version_id = ANY($1) ORDER BY created_at ASC`,
        [versionIds],
      )
      logsMap = logsRes.rows.reduce((acc, l) => {
        if (!acc[l.version_id]) acc[l.version_id] = []
        acc[l.version_id].push(l)
        return acc
      }, {} as Record<string, unknown[]>)
    }

    const value = versRes.rows.map(v => ({ ...v, changes: logsMap[v.id] ?? [] }))
    return NextResponse.json({ ok: true, value })
  } finally {
    client.release()
  }
}

// POST /api/versions/[projectId] — save version with diff
// 支持 body 传入 { tasks, dependencies }，以客户端当前状态为准，确保版本内容正确持久化
export async function POST(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId } = await params

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const proj = await client.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, auth.value.userId],
    )
    if (!proj.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json({ ok: false, error: 'Not found', code: 404 }, { status: 404 })
    }

    // 优先使用客户端传入的当前状态，否则从数据库读取
    let currTasks: TaskRow[]
    let currDeps: DepRow[]
    try {
      const body = await req.json().catch(() => ({}))
      if (Array.isArray(body.tasks) && Array.isArray(body.dependencies)) {
        currTasks = body.tasks.filter((t: TaskRow) => !t.is_deleted)
        currDeps = body.dependencies
      } else {
        const [tasksRes, depsRes] = await Promise.all([
          client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
          client.query(`SELECT d.* FROM dependencies d
            JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
            JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
            WHERE d.project_id = $1`, [projectId]),
        ])
        currTasks = tasksRes.rows
        currDeps = depsRes.rows
      }
    } catch {
      const [tasksRes, depsRes] = await Promise.all([
        client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
        client.query(`SELECT d.* FROM dependencies d
          JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
          JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
          WHERE d.project_id = $1`, [projectId]),
      ])
      currTasks = tasksRes.rows
      currDeps = depsRes.rows
    }

    const snapshot = { tasks: currTasks, dependencies: currDeps }

    // Previous version snapshot for diffing
    const prevRes = await client.query(
      `SELECT snapshot FROM project_versions WHERE project_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [projectId],
    )
    const prevSnap = prevRes.rows[0]?.snapshot as { tasks: TaskRow[]; dependencies: DepRow[] } | undefined
    const changes = prevSnap
      ? diffSnapshots(prevSnap.tasks, prevSnap.dependencies, currTasks, currDeps)
      : currTasks.map(t => ({
          change_type: 'task_add' as const,
          task_name:   t.name as string,
          field_name:  null, old_value: null, new_value: null,
          description: `新增任务「${t.name}」`,
        }))

    // Next version number
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) AS mx FROM project_versions WHERE project_id = $1',
      [projectId],
    )
    const nextVersion = (maxRes.rows[0].mx as number) + 1

    const userRes = await client.query('SELECT username FROM users WHERE id = $1', [auth.value.userId])
    const username = userRes.rows[0]?.username ?? null

    const ins = await client.query(
      `INSERT INTO project_versions (project_id, version_number, snapshot, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, version_number, created_at`,
      [projectId, nextVersion, JSON.stringify(snapshot), auth.value.userId],
    )
    const versionId = ins.rows[0].id

    // Insert change logs
    for (const c of changes) {
      await client.query(
        `INSERT INTO change_logs (project_id, version_id, change_type, task_name, field_name, old_value, new_value, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, versionId, c.change_type, c.task_name, c.field_name, c.old_value, c.new_value, c.description],
      )
    }

    await client.query('COMMIT')
    return NextResponse.json({
      ok: true,
      value: { ...ins.rows[0], task_count: currTasks.length, created_by_name: username, changes },
    })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Save version failed', err)
    return NextResponse.json({ ok: false, error: 'Save failed' }, { status: 500 })
  } finally {
    client.release()
  }
}
