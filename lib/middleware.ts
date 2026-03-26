import { type NextRequest } from 'next/server'
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
