import { getAccessibleProject } from '@/lib/projectAccess'
import { isUuid, projectAccessSql } from '@/lib/projectAccessPolicy'
import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

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
  const { name, start_date, end_date, status_date } = body as {
    name?: string
    start_date?: string | null
    end_date?: string | null
    status_date?: string | null
  }

  if (!isUuid(id)) return NextResponse.json(failure('Project not found', 404), { status: 404 })
  const access = projectAccessSql(auth.value, 6)
  const result = await pool.query(
    `UPDATE projects p
     SET name = COALESCE($1, name),
         start_date = COALESCE($2, start_date),
         end_date = COALESCE($3, end_date),
         status_date = $4
     WHERE p.id = $5 AND (${access.sql})
     RETURNING *`,
    [name ?? null, start_date ?? null, end_date ?? null, status_date ?? null, id, ...access.values]
  )
  if (result.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }
  return NextResponse.json(success(result.rows[0]))
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
