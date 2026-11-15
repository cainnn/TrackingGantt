import { hasProjectAccess } from '@/lib/projectAccess'
import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import type { PoolClient } from 'pg'
import { lockAndCheckPlan, planRevisionHeaders, PlanSaveConflict } from '@/lib/server/planRevision'

type Params = { params: Promise<{ projectId: string }> }

async function mutateLine(req: NextRequest, projectId: string, operation: (client: PoolClient) => Promise<NextResponse>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockAndCheckPlan(client, projectId, req.headers)
    const response = await operation(client)
    if (!response.ok) { await client.query('ROLLBACK'); return response }
    const headers = await planRevisionHeaders(client, projectId, req.headers)
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    await client.query('COMMIT')
    return response
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error instanceof PlanSaveConflict) return NextResponse.json(failure(error.message, 409), { status: 409 })
    console.error('Save project line failed:', error)
    return NextResponse.json(failure('保存项目线失败，请重试', 500), { status: 500 })
  } finally { client.release() }
}

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const { projectId } = await params

  if (!(await hasProjectAccess(projectId, auth.value)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const r = await pool.query(
    'SELECT id, project_id, name, line_date, color, visible FROM project_lines WHERE project_id = $1 ORDER BY line_date',
    [projectId],
  )
  return NextResponse.json(success(r.rows))
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (!(await hasProjectAccess(projectId, auth.value)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id = null, name, line_date, color = '#f59e0b', visible = true } = await req.json()
  if (!name || !line_date)
    return NextResponse.json(failure('name and line_date required', 400), { status: 400 })
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return NextResponse.json(failure('Invalid id', 400), { status: 400 })

  return mutateLine(req, projectId, async client => {
    const r = await client.query(
      `INSERT INTO project_lines (id, project_id, name, line_date, color, visible)
       VALUES (COALESCE($6::uuid, gen_random_uuid()), $1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, line_date = EXCLUDED.line_date,
         color = EXCLUDED.color, visible = EXCLUDED.visible
       WHERE project_lines.project_id = EXCLUDED.project_id
       RETURNING id, project_id, name, line_date, color, visible`,
      [projectId, name, line_date, color, visible, id],
    )
    if (!r.rows[0]) return NextResponse.json(failure('Not found', 404), { status: 404 })
    return NextResponse.json(success(r.rows[0]), { status: 201 })
  })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (!(await hasProjectAccess(projectId, auth.value)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id, name, line_date, color, visible } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  return mutateLine(req, projectId, async client => {
    const r = await client.query(
      `UPDATE project_lines
       SET name = COALESCE($1, name),
           line_date = COALESCE($2, line_date),
           color = COALESCE($3, color),
           visible = COALESCE($4, visible)
       WHERE id = $5 AND project_id = $6
       RETURNING id, project_id, name, line_date, color, visible`,
      [name ?? null, line_date ?? null, color ?? null, visible ?? null, id, projectId],
    )
    if (!r.rows[0])
      return NextResponse.json(failure('Not found', 404), { status: 404 })

    return NextResponse.json(success(r.rows[0]))
  })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (!(await hasProjectAccess(projectId, auth.value)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  return mutateLine(req, projectId, async client => {
    await client.query(
      'DELETE FROM project_lines WHERE id = $1 AND project_id = $2',
      [id, projectId],
    )
    return NextResponse.json(success({ deleted: id }))
  })
}
