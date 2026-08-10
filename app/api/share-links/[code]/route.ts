import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { signShareToken } from '@/lib/auth'
import { hashShareCode } from '@/lib/shareLinks'
import { failure, success } from '@/lib/result'

type Params = { params: Promise<{ code: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const { code } = await params
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM project_share_links WHERE expires_at <= NOW()')
    const result = await client.query(
      `SELECT s.project_id, p.user_id, u.username
       FROM project_share_links s
       JOIN projects p ON p.id = s.project_id
       JOIN users u ON u.id = p.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashShareCode(code)],
    )
    await client.query('COMMIT')
    if (result.rows.length === 0) {
      return NextResponse.json(failure('分享链接无效或已过期', 410), { status: 410 })
    }
    const row = result.rows[0]
    const token = signShareToken({
      userId: row.user_id,
      username: `分享访客(${row.username})`,
      role: 'admin',
      shareProjectId: row.project_id,
    })
    return NextResponse.json(success({
      projectId: row.project_id,
      token,
      user: { id: row.user_id, username: `分享访客(${row.username})`, email: '', role: 'admin' },
    }))
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('open share link failed:', error)
    return NextResponse.json(failure('打开分享链接失败', 500), { status: 500 })
  } finally {
    client.release()
  }
}
