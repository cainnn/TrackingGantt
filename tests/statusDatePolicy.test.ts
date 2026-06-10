import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getNowYmdHm,
  getStatusDateYmdHm,
  getStatusDateYmd,
  getTodayYmd,
  isStatusDateAfterNow,
  isStatusDateAfterToday,
} from '../lib/statusDatePolicy'

test('computes today in the configured app time zone', () => {
  const utcEvening = new Date('2026-06-03T16:30:00Z')

  assert.equal(getTodayYmd(utcEvening, 'Asia/Shanghai'), '2026-06-04')
  assert.equal(getTodayYmd(utcEvening, 'UTC'), '2026-06-03')
  assert.equal(getNowYmdHm(utcEvening, 'Asia/Shanghai'), '2026-06-04T00:30')
  assert.equal(getNowYmdHm(utcEvening, 'UTC'), '2026-06-03T16:30')
})

test('compares status date by calendar day', () => {
  assert.equal(getStatusDateYmd('2026-06-04T09:00:00'), '2026-06-04')
  assert.equal(isStatusDateAfterToday('2026-06-04T09:00:00', '2026-06-04'), false)
  assert.equal(isStatusDateAfterToday('2026-06-05T00:00:00', '2026-06-04'), true)
})

test('compares minute-level status time', () => {
  assert.equal(getStatusDateYmdHm('2026-06-04T09:15:30'), '2026-06-04T09:15')
  assert.equal(getStatusDateYmdHm('2026-06-04 09:15'), '2026-06-04T09:15')
  assert.equal(getStatusDateYmdHm('2026-06-04'), '2026-06-04T00:00')
  assert.equal(isStatusDateAfterNow('2026-06-04T09:16:00', '2026-06-04T09:15'), true)
  assert.equal(isStatusDateAfterNow('2026-06-04T09:15:59', '2026-06-04T09:15'), false)
})
