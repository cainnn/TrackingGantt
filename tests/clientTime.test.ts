import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addMinutesStr,
  diffMinutesStr,
  formatMinDuration,
  snapDateTime,
  toDateTimeStr,
} from '../lib/clientTime'

test('normalizes supported local date inputs to minute precision', () => {
  assert.equal(toDateTimeStr('2026-06-03'), '2026-06-03T00:00:00')
  assert.equal(toDateTimeStr('2026-06-03 09:15:42'), '2026-06-03T09:15:00')
  assert.equal(toDateTimeStr('not-a-date'), null)
})

test('adds, diffs, snaps, and formats minute durations', () => {
  assert.equal(addMinutesStr('2026-06-03T09:00:00', 90), '2026-06-03T10:30:00')
  assert.equal(diffMinutesStr('2026-06-03T09:00:00', '2026-06-03T10:30:00'), 90)
  assert.equal(snapDateTime('2026-06-03T09:07:00', 15), '2026-06-03T09:00:00')
  assert.equal(formatMinDuration(1500), '1天1小时')
})
