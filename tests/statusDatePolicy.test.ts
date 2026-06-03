import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getStatusDateYmd,
  getTodayYmd,
  isStatusDateAfterToday,
} from '../lib/statusDatePolicy'

test('computes today in the configured app time zone', () => {
  const utcEvening = new Date('2026-06-03T16:30:00Z')

  assert.equal(getTodayYmd(utcEvening, 'Asia/Shanghai'), '2026-06-04')
  assert.equal(getTodayYmd(utcEvening, 'UTC'), '2026-06-03')
})

test('compares status date by calendar day', () => {
  assert.equal(getStatusDateYmd('2026-06-04T09:00:00'), '2026-06-04')
  assert.equal(isStatusDateAfterToday('2026-06-04T09:00:00', '2026-06-04'), false)
  assert.equal(isStatusDateAfterToday('2026-06-05T00:00:00', '2026-06-04'), true)
})
