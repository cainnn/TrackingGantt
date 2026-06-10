import { NextRequest, NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

type SnapshotTask = {
  id: string
  parent_id?: string | null
  task_code?: string | null
  name: string
  assignee?: string | null
  start_date?: string | null
  end_date?: string | null
  original_start_date?: string | null
  original_end_date?: string | null
  duration?: number | null
  duration_unit?: string | null
  percent_done?: number | null
  is_milestone?: boolean | null
  auto_schedule?: boolean | null
  constraint_type?: string | null
  constraint_date?: string | null
  deadline?: string | null
  status?: string | null
  note?: string | null
  order_index?: number | null
  rollup?: boolean | null
  inactive?: boolean | null
  project_boundary?: string | null
  baseline_end_date?: string | null
}

type SnapshotDependency = {
  id: string
  from_task_id: string
  to_task_id: string
  type?: number | null
  lag?: number | null
  active?: boolean | null
}

async function verifyOwner(projectId: string, userId: string) {
  const r = await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])
  return r.rows.length > 0
}

async function lockProjectTx(client: PoolClient, projectId: string): Promise<void> {
  await client.query('SET LOCAL lock_timeout = \'10s\'')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])
}

function asTaskArray(value: unknown): SnapshotTask[] {
  return Array.isArray(value) ? value.filter((t): t is SnapshotTask => !!t && typeof t === 'object' && typeof (t as SnapshotTask).id === 'string') : []
}

function asDependencyArray(value: unknown): SnapshotDependency[] {
  return Array.isArray(value) ? value.filter((d): d is SnapshotDependency => !!d && typeof d === 'object' && typeof (d as SnapshotDependency).id === 'string') : []
}

async function upsertTaskShell(client: PoolClient, projectId: string, task: SnapshotTask) {
  await client.query(
    `INSERT INTO tasks
       (id, project_id, parent_id, task_code, name, assignee, start_date, end_date,
        original_start_date, original_end_date, duration, duration_unit, percent_done,
        is_milestone, auto_schedule, constraint_type, constraint_date, deadline, status,
        note, order_index, rollup, inactive, project_boundary, baseline_end_date,
        is_deleted, deleted_at)
     VALUES
       ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,false,NULL)
     ON CONFLICT (id) DO UPDATE SET
       task_code = EXCLUDED.task_code,
       name = EXCLUDED.name,
       assignee = EXCLUDED.assignee,
       start_date = EXCLUDED.start_date,
       end_date = EXCLUDED.end_date,
       original_start_date = EXCLUDED.original_start_date,
       original_end_date = EXCLUDED.original_end_date,
       duration = EXCLUDED.duration,
       duration_unit = EXCLUDED.duration_unit,
       percent_done = EXCLUDED.percent_done,
       is_milestone = EXCLUDED.is_milestone,
       auto_schedule = EXCLUDED.auto_schedule,
       constraint_type = EXCLUDED.constraint_type,
       constraint_date = EXCLUDED.constraint_date,
       deadline = EXCLUDED.deadline,
       status = EXCLUDED.status,
       note = EXCLUDED.note,
       order_index = EXCLUDED.order_index,
       rollup = EXCLUDED.rollup,
       inactive = EXCLUDED.inactive,
       project_boundary = EXCLUDED.project_boundary,
       baseline_end_date = EXCLUDED.baseline_end_date,
       is_deleted = false,
       deleted_at = NULL,
       updated_at = NOW()`,
    [
      task.id, projectId, task.task_code ?? null, task.name, task.assignee ?? null,
      task.start_date ?? null, task.end_date ?? null,
      task.original_start_date ?? null, task.original_end_date ?? null,
      task.duration ?? null, task.duration_unit ?? 'minute', task.percent_done ?? 0,
      task.is_milestone ?? false, task.auto_schedule ?? true,
      task.constraint_type ?? 'asap', task.constraint_date ?? null, task.deadline ?? null,
      task.status ?? null, task.note ?? null, task.order_index ?? 0,
      task.rollup ?? false, task.inactive ?? false, task.project_boundary ?? 'ask',
      task.baseline_end_date ?? null,
    ],
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (auth.value.role !== 'administrator' && !(await verifyOwner(projectId, auth.value.userId))) {
    return NextResponse.json(failure('Not found', 404), { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const versionId = typeof body.id === 'string' ? body.id : ''
  if (!versionId) return NextResponse.json(failure('id required', 400), { status: 400 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockProjectTx(client, projectId)

    const versionRes = await client.query(
      `SELECT id, version_number, name, status_date, snapshot
       FROM project_versions
       WHERE id = $1 AND project_id = $2 AND is_autosave = false`,
      [versionId, projectId],
    )
    if (!versionRes.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Version not found', 404), { status: 404 })
    }

    const version = versionRes.rows[0]
    const tasks = asTaskArray(version.snapshot?.tasks)
    const dependencies = asDependencyArray(version.snapshot?.dependencies)
    if (tasks.length === 0) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Version snapshot has no tasks', 400), { status: 400 })
    }

    for (const task of tasks) await upsertTaskShell(client, projectId, task)

    for (const task of tasks) {
      await client.query(
        `UPDATE tasks
         SET parent_id = $1, updated_at = NOW()
         WHERE id = $2 AND project_id = $3`,
        [task.parent_id ?? null, task.id, projectId],
      )
    }

    const taskIds = tasks.map(t => t.id)
    await client.query(
      `UPDATE tasks
       SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
       WHERE project_id = $1 AND id <> ALL($2::uuid[])`,
      [projectId, taskIds],
    )

    await client.query('DELETE FROM dependencies WHERE project_id = $1', [projectId])
    for (const dep of dependencies) {
      await client.query(
        `INSERT INTO dependencies (id, project_id, from_task_id, to_task_id, type, lag, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           from_task_id = EXCLUDED.from_task_id,
           to_task_id = EXCLUDED.to_task_id,
           type = EXCLUDED.type,
           lag = EXCLUDED.lag,
           active = EXCLUDED.active,
           updated_at = NOW()`,
        [dep.id, projectId, dep.from_task_id, dep.to_task_id, dep.type ?? 2, dep.lag ?? 0, dep.active ?? true],
      )
    }

    await client.query(
      `DELETE FROM project_versions
       WHERE project_id = $1 AND version_number > $2`,
      [projectId, version.version_number],
    )

    await client.query(
      `UPDATE projects
       SET status_date = $1, updated_at = NOW()
       WHERE id = $2`,
      [version.status_date ?? null, projectId],
    )

    const [tasksRes, depsRes] = await Promise.all([
      client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
      client.query(
        `SELECT d.* FROM dependencies d
         JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
         JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
         WHERE d.project_id = $1`,
        [projectId],
      ),
    ])

    await client.query('COMMIT')

    return NextResponse.json(success({
      restored_version: {
        id: version.id,
        version_number: version.version_number,
        name: version.name,
        status_date: version.status_date,
      },
      snapshot: {
        tasks: tasksRes.rows,
        dependencies: depsRes.rows,
      },
      deleted_later_versions: true,
    }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('POST /api/versions/[projectId]/restore:', err)
    return NextResponse.json(failure('Restore failed', 500), { status: 500 })
  } finally {
    client.release()
  }
}
