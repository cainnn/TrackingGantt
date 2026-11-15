import { getAccessibleProject } from '@/lib/projectAccess'
import { isUuid, projectAccessSql } from '@/lib/projectAccessPolicy'
import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { isPlanningStatus } from '@/lib/planningStatus'
import { normalizeCustomFields, CustomFieldError } from '@/lib/taskCustomFields'
import { lockAndCheckPlan, planRevisionHeaders, PlanSaveConflict } from '@/lib/server/planRevision'
import { makePlanBaseline, baselinesEqual } from '@/lib/planBaseline'
import type { PlanBaseline } from '@/types'

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
    await lockAndCheckPlan(client, id, req.headers)
    const access = projectAccessSql(auth.value, 2)
    const existing = await client.query(`SELECT * FROM projects p WHERE p.id = $1 AND (${access.sql}) FOR UPDATE`, [id, ...access.values])
    if (!existing.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Project not found', 404), { status: 404 })
    }
    const fields = Object.hasOwn(body, 'custom_fields') ? normalizeCustomFields(body.custom_fields, existing.rows[0].custom_fields ?? []) : null
    let baseline: PlanBaseline | null = existing.rows[0].plan_baseline ?? null
    if (Object.hasOwn(body, 'plan_baseline')) {
      if (!req.headers.get('x-gantt-plan-revision')) {
        await client.query('ROLLBACK')
        return NextResponse.json(failure('设定固定基线需要最新计划版本，请重新读取计划后重试', 428), { status: 428 })
      }
      const requested = body.plan_baseline
      if (!requested || !isUuid(requested.id) || !isUuid(requested.sourceVersionId)
        || typeof requested.reason !== 'string' || !requested.reason.trim() || requested.reason.length > 1000
        || !Array.isArray(requested.tasks) || requested.tasks.some((t: { id?: unknown } | null) => !t || typeof t.id !== 'string')) {
        await client.query('ROLLBACK')
        return NextResponse.json(failure('请选择有效历史版本并填写基线设定原因（最多 1000 字）', 400), { status: 400 })
      }
      if (!baselinesEqual(baseline, requested)) {
        const source = await client.query('SELECT id, name, created_at, snapshot FROM project_versions WHERE id = $1 AND project_id = $2 FOR SHARE', [requested.sourceVersionId, id])
        if (!source.rows.length) {
          await client.query('ROLLBACK')
          return NextResponse.json(failure('基线来源版本已删除或不属于本项目，请重新选择', 409), { status: 409 })
        }
        baseline = makePlanBaseline(source.rows[0], requested.id, requested.reason)
        if (!baselinesEqual(baseline, requested)) {
          await client.query('ROLLBACK')
          return NextResponse.json(failure('基线来源版本已更新，请重新选择后保存', 409), { status: 409 })
        }
        const duplicate = await client.query('SELECT 1 FROM project_baseline_history WHERE project_id = $1 AND baseline_id = $2', [id, baseline.id])
        if (duplicate.rows.length) {
          await client.query('ROLLBACK')
          return NextResponse.json(failure('该基线变更已保存过，请重新选择版本建立新基线', 409), { status: 409 })
        }
        await client.query(`INSERT INTO project_baseline_history (project_id, baseline_id, previous_baseline, baseline, created_by)
          VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`, [id, baseline.id, JSON.stringify(existing.rows[0].plan_baseline ?? null), JSON.stringify(baseline), auth.value.userId])
      }
    }
    const result = await client.query(
      `UPDATE projects p
       SET name = COALESCE($1, name),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date),
           status_date = CASE WHEN $4::boolean THEN $5::timestamp ELSE status_date END,
           planning_status = COALESCE($7, planning_status),
           custom_fields = COALESCE($8::jsonb, custom_fields),
           plan_baseline = $9::jsonb
       WHERE p.id = $6
       RETURNING *`,
      [name ?? null, start_date ?? null, end_date ?? null,
       Object.hasOwn(body, 'status_date'), status_date ?? null, id, planning_status ?? null, fields ? JSON.stringify(fields) : null, JSON.stringify(baseline)]
    )
    const headers = await planRevisionHeaders(client, id, req.headers)
    await client.query('COMMIT')
    return NextResponse.json(success(result.rows[0]), { headers })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err instanceof PlanSaveConflict) return NextResponse.json(failure(err.message, 409), { status: 409 })
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
