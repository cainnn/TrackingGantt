import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { createShareCode, hashShareCode, shareExpiry } from '@/lib/shareLinks'
import { failure, success } from '@/lib/result'

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth)
  if (writeBlock) return writeBlock

  const { projectId } = await req.json() as { projectId?: string }
  if (!projectId) return NextResponse.json(failure('projectId is required', 400), { status: 400 })
  if (auth.value.shareProjectId) {
    return NextResponse.json(failure('分享会话不能继续创建分享链接', 403), { status: 403 })
  }

  const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (project.rows.length === 0) return NextResponse.json(failure('Project not found', 404), { status: 404 })

  const code = createShareCode()
  const expiresAt = shareExpiry()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM project_share_links WHERE expires_at <= NOW()')
    await client.query(
      'INSERT INTO project_share_links (project_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)',
      [projectId, hashShareCode(code), auth.value.userId, expiresAt],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('create share link failed:', error)
    return NextResponse.json(failure('创建分享链接失败', 500), { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json(success({ code, expiresAt: expiresAt.toISOString() }))
}
