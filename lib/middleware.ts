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

  const auth = verifyToken(token)
  if (!auth.ok || !auth.value.shareProjectId) return auth

  const projectIds = req.nextUrl.pathname.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi) ?? []
  if (projectIds.some(id => id.toLowerCase() !== auth.value.shareProjectId?.toLowerCase())) {
    return failure('分享会话无权访问其他项目', 403)
  }

  const blockedPaths = ['/api/projects', '/api/users']
  if (blockedPaths.some(path => req.nextUrl.pathname === path)) {
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
  if (auth.value.role !== 'administrator') {
    return NextResponse.json(failure('仅管理员可执行此操作', 403), { status: 403 })
  }
  return null
}
