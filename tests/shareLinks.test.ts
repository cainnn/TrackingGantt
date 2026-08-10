import test from 'node:test'
import assert from 'node:assert/strict'
import { createShareCode, hashShareCode, shareExpiry, SHARE_LINK_TTL_MS } from '../lib/shareLinks'

test('share codes are URL-safe, random and stored as hashes', () => {
  const first = createShareCode()
  const second = createShareCode()
  assert.match(first, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(first, second)
  assert.equal(hashShareCode(first).length, 64)
  assert.notEqual(hashShareCode(first), first)
})

test('share links expire exactly one hour after creation', () => {
  const now = new Date('2026-08-10T00:00:00.000Z')
  assert.equal(shareExpiry(now).getTime() - now.getTime(), SHARE_LINK_TTL_MS)
})
