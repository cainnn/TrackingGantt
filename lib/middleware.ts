import { type NextRequest, NextResponse } from 'next/server'
import { verifyToken, type JwtPayload } from './auth'
import { type Result, failure } from './result'

export function getAuthUser(req: NextRequest): Result<JwtPayload> {
  const cookie = req.cookies.get('token')?.value
  const header = req.headers.get('authorization')?.replace('Bearer ', '')
  const token = cookie ?? header

  if (!token) {
    return failure('Unauthorized', 401)
  }

  return verifyToken(token)
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
  if (auth.value.role !== 'administrator') {
    return NextResponse.json(failure('仅管理员可执行此操作', 403), { status: 403 })
  }
  return null
}
