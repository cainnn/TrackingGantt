import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import pool from '@/lib/db'
import { signToken } from '@/lib/auth'
import { success, failure } from '@/lib/result'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { username, email, password } = body as {
    username?: string
    email?: string
    password?: string
  }

  if (!username || !email || !password) {
    return NextResponse.json(failure('username, email and password are required', 400), { status: 400 })
  }

  const passwordHash = await bcrypt.hash(password, 10)

  try {
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
      [username, email, passwordHash]
    )
    const user = result.rows[0]
    const token = signToken({ userId: user.id, username: user.username })

    const response = NextResponse.json(success({ user, token }), { status: 201 })
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    })
    return response
  } catch (err: unknown) {
    const pgErr = err as { code?: string }
    if (pgErr.code === '23505') {
      return NextResponse.json(failure('Username or email already exists', 409), { status: 409 })
    }
    console.error(err)
    return NextResponse.json(failure('Server error', 500), { status: 500 })
  }
}
