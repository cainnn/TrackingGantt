import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import pool from '@/lib/db'
import { signToken } from '@/lib/auth'
import { success, failure } from '@/lib/result'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { login, password } = body as { login?: string; password?: string }

    if (!login || !password) {
      return NextResponse.json(failure('username/email and password are required', 400), { status: 400 })
    }

    const result = await pool.query(
      'SELECT id, username, email, password_hash FROM users WHERE email = $1 OR username = $1',
      [login]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(failure('Invalid credentials', 401), { status: 401 })
    }

    const user = result.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)

    if (!valid) {
      return NextResponse.json(failure('Invalid credentials', 401), { status: 401 })
    }

    const token = signToken({ userId: user.id, username: user.username })
    const { password_hash: _, ...userWithoutHash } = user

    const response = NextResponse.json(success({ user: userWithoutHash, token }))
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    })
    return response
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const isDbError = /connect|ECONNREFUSED|password|database/i.test(msg)
    return NextResponse.json(
      failure(isDbError ? '数据库连接失败，请确认 PostgreSQL 已启动且已执行 migrate' : msg, 500),
      { status: 500 }
    )
  }
}
