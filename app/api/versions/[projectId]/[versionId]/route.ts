import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'

type Params = { projectId: string; versionId: string }

// GET /api/versions/[projectId]/[versionId] — get snapshot data
export async function GET(req: NextRequest, { params }: { params: Promise<Params> }) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId, versionId } = await params
  const client = await pool.connect()
  try {
    const res = await client.query(
      `SELECT v.* FROM project_versions v
       JOIN projects p ON p.id = v.project_id
       WHERE v.id = $1 AND v.project_id = $2 AND p.user_id = $3`,
      [versionId, projectId, auth.value.userId],
    )
    if (!res.rows.length)
      return NextResponse.json({ ok: false, error: 'Not found', code: 404 }, { status: 404 })

    return NextResponse.json({ ok: true, value: res.rows[0].snapshot })
  } finally {
    client.release()
  }
}

// POST /api/versions/[projectId]/[versionId]/restore — restore version
export async function POST(req: NextRequest, { params }: { params: Promise<Params> }) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const { projectId, versionId } = await params
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const res = await client.query(
      `SELECT v.snapshot FROM project_versions v
       JOIN projects p ON p.id = v.project_id
       WHERE v.id = $1 AND v.project_id = $2 AND p.user_id = $3`,
      [versionId, projectId, auth.value.userId],
    )
    if (!res.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json({ ok: false, error: 'Not found', code: 404 }, { status: 404 })
    }

    const { tasks, dependencies } = res.rows[0].snapshot as { tasks: Record<string, unknown>[]; dependencies: Record<string, unknown>[] }

    // Wipe current tasks + deps (cascade removes deps too)
    await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId])

    // Re-insert tasks (two passes: parents first, then children)
    const sorted = [...tasks].sort((a, b) => {
      if (!a.parent_id && b.parent_id) return -1
      if (a.parent_id && !b.parent_id) return 1
      return 0
    })
    for (const t of sorted) {
      await client.query(
        `INSERT INTO tasks
           (id, project_id, parent_id, name, assignee, start_date, end_date,
            duration, duration_unit, percent_done, is_milestone, note, order_index,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, assignee=EXCLUDED.assignee,
           start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
           duration=EXCLUDED.duration, duration_unit=EXCLUDED.duration_unit,
           percent_done=EXCLUDED.percent_done, is_milestone=EXCLUDED.is_milestone,
           note=EXCLUDED.note, order_index=EXCLUDED.order_index,
           updated_at=NOW()`,
        [
          t.id, projectId, t.parent_id ?? null, t.name, t.assignee ?? null,
          t.start_date ?? null, t.end_date ?? null,
          t.duration ?? null, t.duration_unit ?? 'day',
          t.percent_done ?? 0, t.is_milestone ?? false,
          t.note ?? null, t.order_index ?? 0,
          t.created_at, t.updated_at,
        ],
      )
    }

    // Re-insert dependencies
    for (const d of dependencies) {
      await client.query(
        `INSERT INTO dependencies (id, project_id, from_task_id, to_task_id, type, lag)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, projectId, d.from_task_id, d.to_task_id, d.type ?? 2, d.lag ?? 0],
      )
    }

    await client.query('COMMIT')
    return NextResponse.json({ ok: true, value: { tasks, dependencies } })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Restore failed', err)
    return NextResponse.json({ ok: false, error: 'Restore failed' }, { status: 500 })
  } finally {
    client.release()
  }
}
