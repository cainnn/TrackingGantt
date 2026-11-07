import { getAccessibleProject } from '@/lib/projectAccess'
import { isUuid, projectAccessSql } from '@/lib/projectAccessPolicy'
import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { isPlanningStatus } from '@/lib/planningStatus'
import { normalizeCustomFields, CustomFieldError } from '@/lib/taskCustomFields'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { id } = await params

  const result = await getAccessibleProject(id, auth.value)
  if (result.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }
  return NextResponse.json(success(result.rows[0]))
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { id } = await params

  const body = await req.json()
  const { name, start_date, end_date, status_date, planning_status } = body as {
    name?: string
    start_date?: string | null
    end_date?: string | null
    status_date?: string | null
    planning_status?: unknown
  }
  if (Object.hasOwn(body, 'planning_status') && !isPlanningStatus(planning_status)) {
    return NextResponse.json(failure('计划状态必须是草稿态或稳定态', 400), { status: 400 })
  }

  if (!isUuid(id)) return NextResponse.json(failure('Project not found', 404), { status: 404 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '10s'")
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id])
    const access = projectAccessSql(auth.value, 2)
    const existing = await client.query(`SELECT * FROM projects p WHERE p.id = $1 AND (${access.sql}) FOR UPDATE`, [id, ...access.values])
    if (!existing.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Project not found', 404), { status: 404 })
    }
    const fields = Object.hasOwn(body, 'custom_fields') ? normalizeCustomFields(body.custom_fields, existing.rows[0].custom_fields ?? []) : null
    const result = await client.query(
      `UPDATE projects p
       SET name = COALESCE($1, name),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date),
           status_date = CASE WHEN $4::boolean THEN $5::timestamp ELSE status_date END,
           planning_status = COALESCE($7, planning_status),
           custom_fields = COALESCE($8::jsonb, custom_fields)
       WHERE p.id = $6
       RETURNING *`,
      [name ?? null, start_date ?? null, end_date ?? null,
       Object.hasOwn(body, 'status_date'), status_date ?? null, id, planning_status ?? null, fields ? JSON.stringify(fields) : null]
    )
    await client.query('COMMIT')
    return NextResponse.json(success(result.rows[0]))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err instanceof CustomFieldError) return NextResponse.json(failure(err.message, 400), { status: 400 })
    console.error('Update project failed:', err)
    return NextResponse.json(failure('保存项目失败，请重试', 500), { status: 500 })
  } finally { client.release() }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { id } = await params

  if (!isUuid(id)) return NextResponse.json(failure('Project not found', 404), { status: 404 })
  const access = projectAccessSql(auth.value, 2)
  const result = await pool.query(
    `DELETE FROM projects p WHERE p.id = $1 AND (${access.sql}) RETURNING id`,
    [id, ...access.values]
  )
  if (result.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }
  return NextResponse.json(success({ deleted: true }))
}
