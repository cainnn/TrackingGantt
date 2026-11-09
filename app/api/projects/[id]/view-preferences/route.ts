import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { hasProjectAccess } from '@/lib/projectAccess'
import { projectAccessSql } from '@/lib/projectAccessPolicy'
import { normalizeProjectViewPreferences } from '@/lib/clientViewState'
import { failure, success } from '@/lib/result'

type Params = { params: Promise<{ id: string }> }
const columns = 'revision, current_view AS "currentView", saved_views AS views'

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { id } = await params
  try {
    if (!await hasProjectAccess(id, auth.value)) return NextResponse.json(failure('Project not found', 404), { status: 404 })
    // Share tokens carry the owner's user ID; never expose that user's preferences.
    if (auth.value.shareProjectId) return NextResponse.json(success({ revision: 0, currentView: null, views: [], readOnly: true }))
    const result = await pool.query(`SELECT ${columns} FROM project_view_preferences WHERE project_id = $1 AND user_id = $2`, [id, auth.value.userId])
    return NextResponse.json(success(result.rows[0] ?? { revision: 0, currentView: null, views: [] }))
  } catch (error) {
    console.error('Load project layout failed:', error)
    return NextResponse.json(failure('加载项目布局失败，请重试', 500), { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  if (auth.value.shareProjectId) return NextResponse.json(failure('分享访客无法保存个人布局，请使用账号登录', 403), { status: 403 })
  const { id } = await params
  try {
    if (!await hasProjectAccess(id, auth.value)) return NextResponse.json(failure('Project not found', 404), { status: 404 })
    const raw = await req.text()
    if (raw.length > 2000000) return NextResponse.json(failure('布局数据过大', 413), { status: 413 })
    let body: unknown
    try { body = JSON.parse(raw) } catch { return NextResponse.json(failure('布局数据格式无效', 400), { status: 400 }) }
    const value = normalizeProjectViewPreferences(body)
    if (!value) return NextResponse.json(failure('布局数据无效，最多保存 20 个常用布局', 400), { status: 400 })
    // Read-only project members may save their own display preferences.
    const access = projectAccessSql(auth.value, 6)
    const result = await pool.query(
      `INSERT INTO project_view_preferences (project_id, user_id, current_view, saved_views, revision)
       SELECT p.id, $2, $3::jsonb, $4::jsonb, 1 FROM projects p
       WHERE p.id = $1 AND (${access.sql}) AND ($5::integer = 0 OR EXISTS (
         SELECT 1 FROM project_view_preferences WHERE project_id = $1 AND user_id = $2
       ))
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         current_view = EXCLUDED.current_view, saved_views = EXCLUDED.saved_views,
         revision = project_view_preferences.revision + 1, updated_at = NOW()
       WHERE project_view_preferences.revision = $5
       RETURNING ${columns}`,
      [id, auth.value.userId, value.currentView ? JSON.stringify(value.currentView) : null, JSON.stringify(value.views), value.revision, ...access.values],
    )
    if (!result.rows.length) return NextResponse.json(failure('布局已在其他窗口更新，请重新加载布局后再保存', 409), { status: 409 })
    return NextResponse.json(success(result.rows[0]))
  } catch (error) {
    console.error('Save project layout failed:', error)
    return NextResponse.json(failure('保存项目布局失败，请重试', 500), { status: 500 })
  }
}
