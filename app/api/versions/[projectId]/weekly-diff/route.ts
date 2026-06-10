import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { diffSnapshots, type SnapshotTask } from '@/lib/versionDiff'

type Params = { params: Promise<{ projectId: string }> }

type SnapshotDep = {
  id?: string
  from_task_id: string
  to_task_id: string
  type: number
  lag: number | null
  active?: boolean | null
}

type DepDiff = {
  type: 'added' | 'removed' | 'changed'
  from_task_code: string
  from_task_name: string
  to_task_code: string
  to_task_name: string
  changes?: { field: string; old: string; new: string }[]
}

function versionLabel(v: { name: string | null; version_number: number; status_date: string | null }) {
  return v.name || (v.status_date ? String(v.status_date).slice(0, 10) : null) || `快照 #${v.version_number}`
}

function dayValue(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : s
}

function depKey(dep: SnapshotDep, tasksById: Map<string, SnapshotTask>) {
  const from = tasksById.get(dep.from_task_id)?.task_code ?? dep.from_task_id
  const to = tasksById.get(dep.to_task_id)?.task_code ?? dep.to_task_id
  return `${from}->${to}`
}

function depLabel(dep: SnapshotDep, tasksById: Map<string, SnapshotTask>) {
  const from = tasksById.get(dep.from_task_id)
  const to = tasksById.get(dep.to_task_id)
  return {
    from_task_code: from?.task_code ?? dep.from_task_id,
    from_task_name: from?.name ?? dep.from_task_id,
    to_task_code: to?.task_code ?? dep.to_task_id,
    to_task_name: to?.name ?? dep.to_task_id,
  }
}

function buildDependencyDiff(
  oldTasks: SnapshotTask[],
  newTasks: SnapshotTask[],
  oldDeps: SnapshotDep[],
  newDeps: SnapshotDep[],
): DepDiff[] {
  const oldTasksById = new Map(oldTasks.map(t => [t.id, t]))
  const newTasksById = new Map(newTasks.map(t => [t.id, t]))
  const oldMap = new Map(oldDeps.map(d => [depKey(d, oldTasksById), d]))
  const newMap = new Map(newDeps.map(d => [depKey(d, newTasksById), d]))
  const result: DepDiff[] = []

  for (const [key, dep] of newMap) {
    if (!oldMap.has(key)) {
      result.push({ type: 'added', ...depLabel(dep, newTasksById) })
    }
  }
  for (const [key, dep] of oldMap) {
    if (!newMap.has(key)) {
      result.push({ type: 'removed', ...depLabel(dep, oldTasksById) })
    }
  }
  for (const [key, newDep] of newMap) {
    const oldDep = oldMap.get(key)
    if (!oldDep) continue
    const changes: { field: string; old: string; new: string }[] = []
    if (Number(oldDep.type) !== Number(newDep.type)) {
      changes.push({ field: '依赖类型', old: String(oldDep.type), new: String(newDep.type) })
    }
    if (Number(oldDep.lag ?? 0) !== Number(newDep.lag ?? 0)) {
      changes.push({ field: 'Lag', old: String(oldDep.lag ?? 0), new: String(newDep.lag ?? 0) })
    }
    if ((oldDep.active ?? true) !== (newDep.active ?? true)) {
      changes.push({ field: '启用状态', old: (oldDep.active ?? true) ? '启用' : '禁用', new: (newDep.active ?? true) ? '启用' : '禁用' })
    }
    if (changes.length > 0) {
      result.push({ type: 'changed', ...depLabel(newDep, newTasksById), changes })
    }
  }

  const order = { added: 0, changed: 1, removed: 2 }
  return result.sort((a, b) => order[a.type] - order[b.type] || a.to_task_code.localeCompare(b.to_task_code, undefined, { numeric: true }))
}

function classifyScheduleChanges(diffs: ReturnType<typeof diffSnapshots>) {
  const delayed = []
  const shortened = []
  for (const d of diffs) {
    if (d.type !== 'changed' || !d.changes) continue
    const end = d.changes.find(c => c.field === '结束日期')
    if (!end) continue
    if (dayValue(end.new) > dayValue(end.old)) delayed.push(d)
    if (dayValue(end.new) < dayValue(end.old)) shortened.push(d)
  }
  return { delayed, shortened }
}

// GET /api/versions/[projectId]/weekly-diff?current=VERSION_ID
// 自动选 current 之前最近的正式状态日期版本作为基准。
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const projectRes = auth.value.role === 'view'
    ? await pool.query('SELECT id, name, time_granularity FROM projects WHERE id = $1', [projectId])
    : await pool.query('SELECT id, name, time_granularity FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (!projectRes.rows.length) return NextResponse.json(failure('Not found', 404), { status: 404 })

  const currentId = req.nextUrl.searchParams.get('current')
  if (!currentId) return NextResponse.json(failure('current version id required', 400), { status: 400 })

  const currentRes = await pool.query(
    `SELECT id, version_number, name, status_date, created_at, snapshot
     FROM project_versions
     WHERE id = $1 AND project_id = $2 AND is_autosave = false AND status_date IS NOT NULL`,
    [currentId, projectId],
  )
  const current = currentRes.rows[0]
  if (!current) return NextResponse.json(failure('Current status version not found', 404), { status: 404 })

  const baseRes = await pool.query(
    `SELECT id, version_number, name, status_date, created_at, snapshot
     FROM project_versions
     WHERE project_id = $1
       AND is_autosave = false
       AND status_date IS NOT NULL
       AND status_date < $2
     ORDER BY status_date DESC, version_number DESC
     LIMIT 1`,
    [projectId, current.status_date],
  )
  const base = baseRes.rows[0]
  if (!base) return NextResponse.json(failure('没有可对比的前一次状态日期版本', 404), { status: 404 })

  const isMinute = projectRes.rows[0].time_granularity === 'minute'
  const oldTasks: SnapshotTask[] = Array.isArray(base.snapshot?.tasks) ? base.snapshot.tasks : []
  const newTasks: SnapshotTask[] = Array.isArray(current.snapshot?.tasks) ? current.snapshot.tasks : []
  const oldDeps: SnapshotDep[] = Array.isArray(base.snapshot?.dependencies) ? base.snapshot.dependencies : []
  const newDeps: SnapshotDep[] = Array.isArray(current.snapshot?.dependencies) ? current.snapshot.dependencies : []

  const taskDiffs = diffSnapshots(oldTasks, newTasks, { isMinute })
  const dependencyDiffs = buildDependencyDiff(oldTasks, newTasks, oldDeps, newDeps)
  const schedule = classifyScheduleChanges(taskDiffs)
  const summary = {
    task_added: taskDiffs.filter(d => d.type === 'added').length,
    task_removed: taskDiffs.filter(d => d.type === 'removed').length,
    task_changed: taskDiffs.filter(d => d.type === 'changed').length,
    task_delayed: schedule.delayed.length,
    task_shortened: schedule.shortened.length,
    dependency_added: dependencyDiffs.filter(d => d.type === 'added').length,
    dependency_removed: dependencyDiffs.filter(d => d.type === 'removed').length,
    dependency_changed: dependencyDiffs.filter(d => d.type === 'changed').length,
  }

  return NextResponse.json(success({
    project: {
      id: projectId,
      name: projectRes.rows[0].name,
      time_granularity: projectRes.rows[0].time_granularity,
    },
    base: {
      id: base.id,
      version_number: base.version_number,
      name: versionLabel(base),
      status_date: base.status_date,
      created_at: base.created_at,
    },
    current: {
      id: current.id,
      version_number: current.version_number,
      name: versionLabel(current),
      status_date: current.status_date,
      created_at: current.created_at,
    },
    summary,
    tasks: {
      diffs: taskDiffs,
      added: taskDiffs.filter(d => d.type === 'added'),
      removed: taskDiffs.filter(d => d.type === 'removed'),
      changed: taskDiffs.filter(d => d.type === 'changed'),
      delayed: schedule.delayed,
      shortened: schedule.shortened,
    },
    dependencies: {
      diffs: dependencyDiffs,
      added: dependencyDiffs.filter(d => d.type === 'added'),
      removed: dependencyDiffs.filter(d => d.type === 'removed'),
      changed: dependencyDiffs.filter(d => d.type === 'changed'),
    },
    ai_payload: {
      instruction: '请基于两个状态日期版本之间的结构化变更，分析项目工期、计划影响、延期风险、依赖变化和下周建议。',
      base_status_date: base.status_date,
      current_status_date: current.status_date,
      summary,
      task_diffs: taskDiffs,
      dependency_diffs: dependencyDiffs,
    },
  }))
}
