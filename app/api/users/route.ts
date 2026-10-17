import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import pool from '@/lib/db'
import { getAuthUser, requireAdministrator } from '@/lib/middleware'
import { isUuid } from '@/lib/projectAccessPolicy'
import { success, failure } from '@/lib/result'

function serverError(error: unknown) {
  console.error('User management failed:', error)
  return NextResponse.json(failure('用户操作失败，请重试', 500), { status: 500 })
}

export async function GET(req: NextRequest) {
  const block = requireAdministrator(await getAuthUser(req))
  if (block) return block
  try {
    const result = await pool.query('SELECT id, username, email, role, created_at FROM users ORDER BY created_at, id')
    return NextResponse.json(success(result.rows))
  } catch (error) { return serverError(error) }
}

export async function POST(req: NextRequest) {
  const block = requireAdministrator(await getAuthUser(req))
  if (block) return block
  const body = await req.json().catch(() => null)
  if (!body || typeof body.username !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json(failure('用户名、邮箱和密码不能为空', 400), { status: 400 })
  }
  const username = body.username.trim()
  const email = body.email.trim()
  const password = body.password as string
  const role = body.role ?? 'admin'
  if (!username || username.length > 50 || username.toLowerCase() === 'root' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    return NextResponse.json(failure('请填写有效的用户名和邮箱（root 为保留账号）', 400), { status: 400 })
  }
  if (!password) {
    return NextResponse.json(failure('密码不能为空', 400), { status: 400 })
  }
  if (!['admin', 'view'].includes(role)) {
    return NextResponse.json(failure('请选择普通用户或只读用户', 400), { status: 400 })
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10)
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at`,
      [username, email, passwordHash, role],
    )
    return NextResponse.json(success(result.rows[0]), { status: 201 })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(failure('用户名或邮箱已存在', 409), { status: 409 })
    }
    return serverError(error)
  }
}

export async function PUT(req: NextRequest) {
  const block = requireAdministrator(await getAuthUser(req))
  if (block) return block
  const body = await req.json().catch(() => null)
  if (!isUuid(body?.userId) || typeof body?.password !== 'string' || !body.password) {
    return NextResponse.json(failure('请提供有效的用户 ID 和新密码', 400), { status: 400 })
  }
  try {
    const passwordHash = await bcrypt.hash(body.password, 10)
    const result = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
      [passwordHash, body.userId],
    )
    if (!result.rowCount) return NextResponse.json(failure('用户不存在', 404), { status: 404 })
    return NextResponse.json(success({ message: '密码已更新' }))
  } catch (error) { return serverError(error) }
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block
  const body = await req.json().catch(() => null)
  if (!isUuid(body?.userId)) return NextResponse.json(failure('请提供有效的用户 ID', 400), { status: 400 })
  if (auth.ok && auth.value.userId === body.userId) {
    return NextResponse.json(failure('不能删除自己的账号', 400), { status: 400 })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const user = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [body.userId])
    if (!user.rows.length || user.rows[0].role === 'administrator') {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('用户不存在或为受保护的管理员账号', 400), { status: 400 })
    }
    // projects.user_id currently cascades on deletion: never delete a creator's projects implicitly.
    const owned = await client.query('SELECT id FROM projects WHERE user_id = $1 LIMIT 1', [body.userId])
    if (owned.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('该用户仍有创建的项目，不能删除账号；可在项目关联中移除访问权限', 409), { status: 409 })
    }
    await client.query('DELETE FROM users WHERE id = $1', [body.userId])
    await client.query('COMMIT')
    return NextResponse.json(success({ message: '用户已删除' }))
  } catch (error) {
    await client.query('ROLLBACK')
    return serverError(error)
  } finally { client.release() }
}
