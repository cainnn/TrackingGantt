import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { diffSnapshots, type SnapshotTask } from '@/lib/versionDiff'

type Params = { params: Promise<{ projectId: string }> }

// GET /api/versions/[projectId]/diff?v1=VERSION_ID&v2=VERSION_ID
// v1 = base version, v2 = compare version
// If v2 is omitted or "current", compare against the current working state
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  const proj = auth.value.role === 'view'
    ? await pool.query('SELECT id FROM projects WHERE id = $1', [projectId])
    : await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (!proj.rows.length)
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const v1Id = req.nextUrl.searchParams.get('v1')
  const v2Id = req.nextUrl.searchParams.get('v2')

  if (!v1Id)
    return NextResponse.json(failure('v1 (base version ID) required', 400), { status: 400 })

  // Load v1 snapshot
  const v1Res = await pool.query(
    'SELECT snapshot, name, version_number, created_at FROM project_versions WHERE id = $1 AND project_id = $2',
    [v1Id, projectId],
  )
  if (!v1Res.rows.length)
    return NextResponse.json(failure('Version v1 not found', 404), { status: 404 })

  const v1 = v1Res.rows[0]
  const oldTasks: SnapshotTask[] = v1.snapshot.tasks ?? []

  let newTasks: SnapshotTask[]
  let v2Name: string
  let v2Date: string

  if (!v2Id || v2Id === 'current') {
    // Compare against current working state
    const tasksRes = await pool.query(
      'SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index',
      [projectId],
    )
    newTasks = tasksRes.rows
    v2Name = '当前工作版本'
    v2Date = new Date().toISOString()
  } else {
    // Load v2 snapshot
    const v2Res = await pool.query(
      'SELECT snapshot, name, version_number, created_at FROM project_versions WHERE id = $1 AND project_id = $2',
      [v2Id, projectId],
    )
    if (!v2Res.rows.length)
      return NextResponse.json(failure('Version v2 not found', 404), { status: 404 })
    const v2 = v2Res.rows[0]
    newTasks = v2.snapshot.tasks ?? []
    v2Name = v2.name || `快照 #${v2.version_number}`
    v2Date = v2.created_at
  }

  const diffs = diffSnapshots(oldTasks, newTasks)

  return NextResponse.json(success({
    base: {
      id: v1Id,
      name: v1.name || `快照 #${v1.version_number}`,
      date: v1.created_at,
    },
    compare: { name: v2Name, date: v2Date },
    diffs,
    stats: {
      added: diffs.filter(d => d.type === 'added').length,
      removed: diffs.filter(d => d.type === 'removed').length,
      changed: diffs.filter(d => d.type === 'changed').length,
    },
  }))
}
