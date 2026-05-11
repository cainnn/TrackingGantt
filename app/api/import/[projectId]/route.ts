import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import {
  cascadeDependencies,
  updateSummaryTasksDates,
} from '@/lib/scheduling'
import { diffSnapshots, type SnapshotTask } from '@/lib/versionDiff'

type Params = { params: Promise<{ projectId: string }> }

/** Normalize any date string to YYYY-MM-DD, or return null */
function toDateStr(v: unknown): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (!s) return null
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // YYYY-MM-DDT... or YYYY-MM-DD ...
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return s.slice(0, 10)
  // Try parsing (handles "Mon Feb 23 2026 ..." etc.)
  const d = new Date(s)
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return null
}

interface ImportTask {
  task_code: string
  level: number
  parent_task_code: string
  name: string
  assignee: string | null
  start_date: string | null
  end_date: string | null
  duration: number | null
  is_milestone: boolean
  auto_schedule: boolean
  note: string | null
  percent_done?: number | null
  constraint_type?: string | null
  constraint_date?: string | null
  rollup?: boolean
  inactive?: boolean
  project_boundary?: string | null
  status?: string | null
  deadline?: string | null
  baseline_end_date?: string | null
}

interface ImportDep {
  from_task_code: string
  to_task_code: string
  type: number
  lag: number
  active?: boolean
}

/** 允许的最大日期跨度（天） */
const MAX_DATE_SPAN_DAYS = 3650

/**
 * 服务端校验导入数据，返回错误消息数组。空数组表示通过。
 */
function validateImportTasks(
  tasks: ImportTask[],
  deps: ImportDep[],
): string[] {
  const errors: string[] = []
  const codeSet = new Set(tasks.map(t => t.task_code))

  // 1. 循环父引用检测
  const parentMap = new Map<string, string>()
  for (const t of tasks) {
    // 自引用
    if (t.parent_task_code === t.task_code) {
      errors.push(`任务「${t.name}」(${t.task_code}) 的父任务指向自己`)
      continue
    }
    if (t.parent_task_code && codeSet.has(t.parent_task_code)) {
      parentMap.set(t.task_code, t.parent_task_code)
    }
  }
  {
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const findCycle = (code: string): boolean => {
      if (inStack.has(code)) return true
      if (visited.has(code)) return false
      visited.add(code)
      inStack.add(code)
      const p = parentMap.get(code)
      if (p && findCycle(p)) {
        errors.push(`父任务循环引用涉及任务 ${code}`)
        return true
      }
      inStack.delete(code)
      return false
    }
    for (const code of parentMap.keys()) {
      if (!visited.has(code) && findCycle(code)) break
    }
  }

  // 2. 依赖循环检测
  {
    const adj = new Map<string, string[]>()
    for (const d of deps) {
      if (!codeSet.has(d.from_task_code) || !codeSet.has(d.to_task_code)) continue
      if (d.from_task_code === d.to_task_code) {
        errors.push(`任务 ${d.from_task_code} 依赖指向自身`)
        continue
      }
      if (!adj.has(d.from_task_code)) adj.set(d.from_task_code, [])
      adj.get(d.from_task_code)!.push(d.to_task_code)
    }
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const findCycle = (code: string): boolean => {
      if (inStack.has(code)) return true
      if (visited.has(code)) return false
      visited.add(code)
      inStack.add(code)
      for (const next of adj.get(code) ?? []) {
        if (findCycle(next)) {
          errors.push(`依赖循环引用涉及任务 ${code}`)
          return true
        }
      }
      inStack.delete(code)
      return false
    }
    for (const code of adj.keys()) {
      if (!visited.has(code) && findCycle(code)) break
    }
  }

  // 3. 日期校验
  let globalMin: string | null = null
  let globalMax: string | null = null
  const validDate = /^\d{4}-\d{2}-\d{2}$/

  for (const t of tasks) {
    if (t.start_date && !validDate.test(t.start_date)) {
      errors.push(`任务「${t.name}」(${t.task_code}) 开始日期格式无效：${t.start_date}`)
    }
    if (t.end_date && !validDate.test(t.end_date)) {
      errors.push(`任务「${t.name}」(${t.task_code}) 结束日期格式无效：${t.end_date}`)
    }
    if (t.start_date && t.end_date && validDate.test(t.start_date) && validDate.test(t.end_date) && t.start_date > t.end_date) {
      errors.push(`任务「${t.name}」(${t.task_code}) 开始日期 ${t.start_date} 晚于结束日期 ${t.end_date}`)
    }
    if (t.start_date && validDate.test(t.start_date)) {
      if (!globalMin || t.start_date < globalMin) globalMin = t.start_date
    }
    if (t.end_date && validDate.test(t.end_date)) {
      if (!globalMax || t.end_date > globalMax) globalMax = t.end_date
    }
  }

  if (globalMin && globalMax) {
    const span = Math.round(
      (new Date(globalMin + 'T00:00:00').getTime() - new Date(globalMax + 'T00:00:00').getTime()) / -86_400_000
    )
    if (span > MAX_DATE_SPAN_DAYS) {
      errors.push(`日期跨度 ${span} 天（${globalMin} ~ ${globalMax}）超过上限 ${MAX_DATE_SPAN_DAYS} 天`)
    }
  }

  return errors
}

// Full replace: delete all existing, insert from Excel
async function importReplace(
  client: PoolClient,
  projectId: string,
  importTasks: ImportTask[],
  importDeps: ImportDep[],
) {
  await client.query('DELETE FROM dependencies WHERE project_id = $1', [projectId])
  await client.query('DELETE FROM task_lifecycle WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [projectId])
  await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId])

  const codeToId = new Map<string, string>()
  importTasks.forEach(t => codeToId.set(t.task_code, randomUUID()))

  for (let i = 0; i < importTasks.length; i++) {
    const t = importTasks[i]
    const id = codeToId.get(t.task_code)!
    const rawParentId = t.parent_task_code ? (codeToId.get(t.parent_task_code) ?? null) : null
    // 防止自引用：parent_id 不能等于自身 id
    const parentId = rawParentId === id ? null : rawParentId
    await client.query(
      `INSERT INTO tasks (id, project_id, parent_id, task_code, name, assignee,
       start_date, end_date, duration, is_milestone, auto_schedule, note, order_index,
       is_deleted, percent_done, duration_unit,
       constraint_type, constraint_date, rollup, inactive, project_boundary,
       status, deadline, baseline_end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14,'day',
               $15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, projectId, parentId, t.task_code, t.name, t.assignee,
       t.start_date, t.end_date, t.duration, t.is_milestone,
       t.auto_schedule, t.note, i,
       t.percent_done ?? 0,
       t.constraint_type ?? 'asap', toDateStr(t.constraint_date),
       t.rollup ?? false, t.inactive ?? false, t.project_boundary ?? 'ask',
       t.status ?? null, toDateStr(t.deadline), toDateStr(t.baseline_end_date)]
    )
  }

  for (const dep of importDeps) {
    const fromId = codeToId.get(dep.from_task_code)
    const toId = codeToId.get(dep.to_task_code)
    if (!fromId || !toId) continue
    await client.query(
      `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag, active)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [projectId, fromId, toId, dep.type, dep.lag, dep.active !== false]
    )
  }
}

// Merge: update existing tasks (by task_code), insert new ones, add new deps
async function importMerge(
  client: PoolClient,
  projectId: string,
  importTasks: ImportTask[],
  importDeps: ImportDep[],
) {
  // Load existing tasks and build code->id map
  const existingRes = await client.query(
    'SELECT id, task_code, order_index FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index',
    [projectId]
  )
  const existingCodeToId = new Map<string, string>()
  let maxOrder = 0
  for (const row of existingRes.rows) {
    existingCodeToId.set(row.task_code, row.id)
    if (row.order_index > maxOrder) maxOrder = row.order_index
  }

  // Combined code->id map (existing + new)
  const codeToId = new Map(existingCodeToId)

  // Separate tasks into update vs insert
  const toUpdate: (ImportTask & { id: string })[] = []
  const toInsert: ImportTask[] = []
  for (const t of importTasks) {
    const existingId = existingCodeToId.get(t.task_code)
    if (existingId) {
      toUpdate.push({ ...t, id: existingId })
    } else {
      const newId = randomUUID()
      codeToId.set(t.task_code, newId)
      toInsert.push(t)
    }
  }

  // Update existing tasks
  for (const t of toUpdate) {
    const rawParentId = t.parent_task_code ? (codeToId.get(t.parent_task_code) ?? null) : null
    const parentId = rawParentId === t.id ? null : rawParentId
    await client.query(
      `UPDATE tasks SET parent_id=$1, name=$2, assignee=$3, start_date=$4, end_date=$5,
       duration=$6, is_milestone=$7, auto_schedule=$8, note=$9,
       percent_done=COALESCE($12, percent_done),
       constraint_type=COALESCE($13, constraint_type),
       constraint_date=$14,
       rollup=COALESCE($15, rollup),
       inactive=COALESCE($16, inactive),
       project_boundary=COALESCE($17, project_boundary),
       status=COALESCE($18, status),
       deadline=$19,
       baseline_end_date=$20
       WHERE id=$10 AND project_id=$11`,
      [parentId, t.name, t.assignee, t.start_date, t.end_date,
       t.duration, t.is_milestone, t.auto_schedule, t.note, t.id, projectId,
       t.percent_done ?? null,
       t.constraint_type ?? null, toDateStr(t.constraint_date),
       t.rollup ?? null, t.inactive ?? null, t.project_boundary ?? null,
       t.status ?? null, toDateStr(t.deadline), toDateStr(t.baseline_end_date)]
    )
  }

  // Insert new tasks
  let orderIdx = maxOrder + 1
  for (const t of toInsert) {
    const id = codeToId.get(t.task_code)!
    const rawParentId = t.parent_task_code ? (codeToId.get(t.parent_task_code) ?? null) : null
    const parentId = rawParentId === id ? null : rawParentId
    await client.query(
      `INSERT INTO tasks (id, project_id, parent_id, task_code, name, assignee,
       start_date, end_date, duration, is_milestone, auto_schedule, note, order_index,
       is_deleted, percent_done, duration_unit,
       constraint_type, constraint_date, rollup, inactive, project_boundary,
       status, deadline, baseline_end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14,'day',
               $15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, projectId, parentId, t.task_code, t.name, t.assignee,
       t.start_date, t.end_date, t.duration, t.is_milestone,
       t.auto_schedule, t.note, orderIdx++,
       t.percent_done ?? 0,
       t.constraint_type ?? 'asap', toDateStr(t.constraint_date),
       t.rollup ?? false, t.inactive ?? false, t.project_boundary ?? 'ask',
       t.status ?? null, toDateStr(t.deadline), toDateStr(t.baseline_end_date)]
    )
  }

  // Process dependencies: for each imported dep, upsert
  for (const dep of importDeps) {
    const fromId = codeToId.get(dep.from_task_code)
    const toId = codeToId.get(dep.to_task_code)
    if (!fromId || !toId) continue
    // Check if dep already exists
    const existing = await client.query(
      'SELECT id FROM dependencies WHERE project_id=$1 AND from_task_id=$2 AND to_task_id=$3',
      [projectId, fromId, toId]
    )
    if (existing.rows.length > 0) {
      await client.query(
        'UPDATE dependencies SET type=$1, lag=$2, active=$3 WHERE id=$4',
        [dep.type, dep.lag, dep.active !== false, existing.rows[0].id]
      )
    } else {
      await client.query(
        `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag, active)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectId, fromId, toId, dep.type, dep.lag, dep.active !== false]
      )
    }
  }

  return { updated: toUpdate.length, inserted: toInsert.length }
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  const owned = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, auth.value.userId]
  )
  if (owned.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }

  let body: {
    tasks: ImportTask[];
    dependencies: ImportDep[];
    mode?: 'replace' | 'merge';
    status_date?: string | null;
    project_lines?: Array<{ name: string; line_date: string; color: string; visible: boolean }>;
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON', 400), { status: 400 })
  }

  const { tasks: rawTasks, dependencies: importDeps, mode = 'replace', status_date, project_lines } = body
  // Sanitize dates on all tasks
  const importTasks = (rawTasks as ImportTask[]).map(t => ({
    ...t,
    start_date: toDateStr(t.start_date),
    end_date: toDateStr(t.end_date),
  }))
  if (!Array.isArray(importTasks) || importTasks.length === 0) {
    return NextResponse.json(failure('No tasks to import', 400), { status: 400 })
  }

  const codes = importTasks.map(t => t.task_code)
  const uniqueCodes = new Set(codes)
  if (uniqueCodes.size !== codes.length) {
    return NextResponse.json(failure('Duplicate task codes found', 400), { status: 400 })
  }

  // ── 数据完整性校验：阻止会导致渲染崩溃的数据 ──
  const validationErrors = validateImportTasks(importTasks, importDeps)
  if (validationErrors.length > 0) {
    return NextResponse.json(
      failure('导入数据校验失败：\n' + validationErrors.join('\n'), 400),
      { status: 400 },
    )
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])

    let message: string
    if (mode === 'merge') {
      const { updated, inserted } = await importMerge(client, projectId, importTasks, importDeps)
      message = `合并导入完成：更新 ${updated} 个任务，新增 ${inserted} 个任务，处理 ${importDeps.length} 个依赖关系`
    } else {
      await importReplace(client, projectId, importTasks, importDeps)
      message = `成功替换导入 ${importTasks.length} 个任务和 ${importDeps.length} 个依赖关系`
    }

    // Optionally update status_date
    if (status_date !== undefined) {
      await client.query('UPDATE projects SET status_date = $1 WHERE id = $2', [status_date, projectId])
    }

    // Optionally import project lines (replace all)
    if (project_lines && project_lines.length > 0) {
      await client.query('DELETE FROM project_lines WHERE project_id = $1', [projectId])
      for (const pl of project_lines) {
        await client.query(
          `INSERT INTO project_lines (project_id, name, line_date, color, visible)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectId, pl.name, pl.line_date, pl.color, pl.visible !== false],
        )
      }
    }

    // ── 依赖级联 + 摘要任务日期更新 ─────────────────────────────────
    await cascadeDependencies(client, projectId)
    await updateSummaryTasksDates(client, projectId)

    await client.query('COMMIT')

    // ── 读取最终数据 ─────────────────────────────────────────────────
    const tasksRes = await pool.query(
      'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index',
      [projectId]
    )
    const depsRes = await pool.query(
      `SELECT d.* FROM dependencies d
       JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
       JOIN tasks tt ON tt.id = d.to_task_id   AND tt.is_deleted = false
       WHERE d.project_id = $1`,
      [projectId]
    )

    // Fetch updated project for status_date
    const updatedProj = await pool.query('SELECT status_date FROM projects WHERE id = $1', [projectId])
    const updatedStatusDate = updatedProj.rows[0]?.status_date
      ? toDateStr(updatedProj.rows[0].status_date) : null

    // Fetch project lines
    const plRes = await pool.query(
      'SELECT id, project_id, name, line_date, color, visible FROM project_lines WHERE project_id = $1 ORDER BY line_date',
      [projectId],
    )

    // ── 创建版本快照 ─────────────────────────────────────────────────
    let versionInfo = null
    {
      const snapshotTasks = tasksRes.rows
      const snapshotDeps = depsRes.rows
      const snapshot = { tasks: snapshotTasks, dependencies: snapshotDeps }

      const effectiveStatusDate = updatedStatusDate ?? null

      // 计算与上一版本的差异
      const lastRes = await pool.query(
        `SELECT id, version_number, status_date, snapshot FROM project_versions
         WHERE project_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [projectId],
      )
      const lastVersion = lastRes.rows[0] ?? null
      let changes = null
      if (lastVersion) {
        const prevTasks: SnapshotTask[] = lastVersion.snapshot?.tasks ?? []
        const diffs = diffSnapshots(prevTasks, snapshotTasks)
        changes = {
          diffs,
          stats: {
            added: diffs.filter((d: { type: string }) => d.type === 'added').length,
            removed: diffs.filter((d: { type: string }) => d.type === 'removed').length,
            changed: diffs.filter((d: { type: string }) => d.type === 'changed').length,
          },
        }
      }

      const maxRes = await pool.query(
        'SELECT COALESCE(MAX(version_number), 0) AS mx FROM project_versions WHERE project_id = $1',
        [projectId],
      )
      const nextVersion = (maxRes.rows[0].mx as number) + 1
      const versionName = `导入 #${nextVersion}`

      const insRes = await pool.query(
        `INSERT INTO project_versions (project_id, version_number, name, description, snapshot, changes, status_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, version_number, name, status_date, created_at`,
        [projectId, nextVersion, versionName, `Excel ${mode === 'merge' ? '合并' : '替换'}导入`,
         JSON.stringify(snapshot), changes ? JSON.stringify(changes) : null,
         effectiveStatusDate, auth.value.userId],
      )
      versionInfo = { ...insRes.rows[0], task_count: snapshotTasks.length, changes }
    }

    return NextResponse.json(success({
      tasks: tasksRes.rows,
      dependencies: depsRes.rows,
      message,
      status_date: updatedStatusDate,
      project_lines: plRes.rows,
      version: versionInfo,
    }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Import error:', err)
    return NextResponse.json(failure('Import failed: ' + (err instanceof Error ? err.message : 'Unknown error'), 500), { status: 500 })
  } finally {
    client.release()
  }
}
