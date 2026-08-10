import { createHash, randomBytes } from 'crypto'

export const SHARE_LINK_TTL_MS = 60 * 60 * 1000

export function createShareCode(): string {
  return randomBytes(18).toString('base64url')
}

export function hashShareCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function shareExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SHARE_LINK_TTL_MS)
}
