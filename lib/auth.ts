import jwt from 'jsonwebtoken'
import { type Result, success, failure } from './result'

const JWT_SECRET = process.env.JWT_SECRET ?? 'gantt-secret-key-change-in-production'
const JWT_EXPIRES_IN = '7d'

export interface JwtPayload {
  userId: string
  username: string
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token: string): Result<JwtPayload> {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload
    return success(payload)
  } catch {
    return failure('Invalid or expired token', 401)
  }
}
