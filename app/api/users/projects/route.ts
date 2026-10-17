import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireAdministrator } from '@/lib/middleware'
import { isUuid } from '@/lib/projectAccessPolicy'
import { success, failure } from '@/lib/result'

export async function GET(req: NextRequest) {
  const auth = await getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.user_id, u.username AS creator_name,
        ARRAY(SELECT pm.user_id FROM project_memberships pm WHERE pm.project_id = p.id) AS member_ids
      FROM projects p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC, p.id
    `)
    return NextResponse.json(success(result.rows))
  } catch (error) {
    console.error('Load project memberships failed:', error)
    return NextResponse.json(failure('加载项目关联失败', 500), { status: 500 })
  }
}

async function changeMembership(req: NextRequest, associate: boolean) {
  const auth = await getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block
  const body = await req.json().catch(() => null)
  if (!isUuid(body?.userId) || !isUuid(body?.projectId)) {
    return NextResponse.json(failure('请提供有效的用户和项目 ID', 400), { status: 400 })
  }
  const { userId, projectId } = body as { userId: string; projectId: string }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock the target user while checking their role and updating an association.
    const user = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [userId])
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR KEY SHARE', [projectId])
    if (!user.rows.length || !project.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('用户或项目不存在，请刷新后重试', 404), { status: 404 })
    }
    if (user.rows[0].role === 'administrator') {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('超级管理员始终可以访问全部项目，无需关联', 400), { status: 400 })
    }
    if (associate) {
      await client.query('INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, userId])
    } else {
      await client.query('DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2', [projectId, userId])
    }
    await client.query('COMMIT')
    return NextResponse.json(success({ userId, projectId, associated: associate }))
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Update project membership failed:', error)
    return NextResponse.json(failure('保存项目关联失败，请重试', 500), { status: 500 })
  } finally {
    client.release()
  }
}

export async function POST(req: NextRequest) { return changeMembership(req, true) }
export async function DELETE(req: NextRequest) { return changeMembership(req, false) }
