import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import pool from '@/lib/db'
import { getAuthUser, requireAdministrator } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

// GET - 获取用户列表（仅 administrator）
export async function GET(req: NextRequest) {
  const auth = getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block

  const result = await pool.query(
    `SELECT id, username, email, role, created_at FROM users ORDER BY created_at`
  )
  return NextResponse.json(success(result.rows))
}

// POST - 创建新用户（仅 administrator）
export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block

  const { username, email, password } = await req.json() as {
    username?: string; email?: string; password?: string
  }

  if (!username?.trim() || !email?.trim() || !password) {
    return NextResponse.json(failure('用户名、邮箱和密码不能为空', 400), { status: 400 })
  }
  if (password.length < 6) {
    return NextResponse.json(failure('密码长度不能少于6位', 400), { status: 400 })
  }

  const passwordHash = await bcrypt.hash(password, 10)

  try {
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, username, email, role, created_at`,
      [username.trim(), email.trim(), passwordHash]
    )
    return NextResponse.json(success(result.rows[0]), { status: 201 })
  } catch (err: unknown) {
    const pgErr = err as { code?: string }
    if (pgErr.code === '23505') {
      return NextResponse.json(failure('用户名或邮箱已存在', 409), { status: 409 })
    }
    console.error(err)
    return NextResponse.json(failure('服务器错误', 500), { status: 500 })
  }
}

// PUT - 修改用户密码（仅 administrator）
export async function PUT(req: NextRequest) {
  const auth = getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block

  const { userId, password } = await req.json() as {
    userId?: string; password?: string
  }

  if (!userId || !password) {
    return NextResponse.json(failure('用户ID和新密码不能为空', 400), { status: 400 })
  }
  if (password.length < 6) {
    return NextResponse.json(failure('密码长度不能少于6位', 400), { status: 400 })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const result = await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, username`,
    [passwordHash, userId]
  )

  if (result.rowCount === 0) {
    return NextResponse.json(failure('用户不存在', 404), { status: 404 })
  }
  return NextResponse.json(success({ message: '密码已更新' }))
}

// DELETE - 删除用户（仅 administrator，不能删自己和其他 administrator）
export async function DELETE(req: NextRequest) {
  const auth = getAuthUser(req)
  const block = requireAdministrator(auth)
  if (block) return block

  const { userId } = await req.json() as { userId?: string }

  if (!userId) {
    return NextResponse.json(failure('用户ID不能为空', 400), { status: 400 })
  }

  // 不能删除自己
  if (auth.ok && auth.value.userId === userId) {
    return NextResponse.json(failure('不能删除自己的账号', 400), { status: 400 })
  }

  // 不能删除其他 administrator
  const check = await pool.query('SELECT role FROM users WHERE id = $1', [userId])
  if (check.rows.length === 0) {
    return NextResponse.json(failure('用户不存在', 404), { status: 404 })
  }
  if (check.rows[0].role === 'administrator') {
    return NextResponse.json(failure('不能删除管理员账号', 400), { status: 400 })
  }

  await pool.query('DELETE FROM users WHERE id = $1', [userId])
  return NextResponse.json(success({ message: '用户已删除' }))
}
