import jwt from 'jsonwebtoken'
import { type Result, success, failure } from './result'

const JWT_EXPIRES_IN = '7d'

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured in production')
  }
  return secret ?? 'gantt-secret-key-change-in-production'
}

export interface JwtPayload {
  userId: string
  username: string
  role: 'administrator' | 'admin' | 'view'
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token: string): Result<JwtPayload> {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JwtPayload
    return success(payload)
  } catch {
    return failure('Invalid or expired token', 401)
  }
}
