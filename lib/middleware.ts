import { type NextRequest, NextResponse } from 'next/server'
import { verifyToken, type JwtPayload } from './auth'
import { type Result, failure } from './result'
import pool from './db'
import { isUuid } from './projectAccessPolicy'

export async function getAuthUser(req: NextRequest): Promise<Result<JwtPayload>> {
  const cookie = req.cookies.get('token')?.value
  const header = req.headers.get('authorization')?.replace('Bearer ', '')
  const token = cookie ?? header

  if (!token) {
    return failure('Unauthorized', 401)
  }

  const auth = verifyToken(token)
  if (!auth.ok) return auth
  if (!isUuid(auth.value.userId)) return failure('Unauthorized', 401)
  if (!auth.value.shareProjectId) {
    try {
      const result = await pool.query('SELECT username, role FROM users WHERE id = $1', [auth.value.userId])
      const user = result.rows[0]
      if (!user || !['administrator', 'admin', 'view'].includes(user.role)) return failure('Unauthorized', 401)
      return { ok: true, value: { userId: auth.value.userId, username: user.username, role: user.role } }
    } catch (error) {
      console.error('Authentication lookup failed:', error)
      return failure('数据库连接失败', 500)
    }
  }
  if (!isUuid(auth.value.shareProjectId)) return failure('Unauthorized', 401)

  // Project routes enforce the share scope through projectAccessSql. Do not
  // mistake a task/version ID later in the path for a different project ID.
  const blockedPaths = ['/api/projects', '/api/users']
  if (blockedPaths.some(path => req.nextUrl.pathname === path || (path === '/api/users' && req.nextUrl.pathname.startsWith(`${path}/`)))) {
    return failure('分享会话仅限当前项目', 403)
  }
  return auth
}

/** 检查写权限，view 用户返回 403 响应，admin/administrator 返回 null（放行） */
export function requireWrite(auth: Result<JwtPayload>): NextResponse | null {
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  if (auth.value.role === 'view') {
    return NextResponse.json(failure('只读用户无权执行此操作', 403), { status: 403 })
  }
  return null
}

/** 检查是否为 administrator 角色 */
export function requireAdministrator(auth: Result<JwtPayload>): NextResponse | null {
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  if (auth.value.shareProjectId || auth.value.role !== 'administrator') {
    return NextResponse.json(failure('仅管理员可执行此操作', 403), { status: 403 })
  }
  return null
}
