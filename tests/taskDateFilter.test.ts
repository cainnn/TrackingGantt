import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTaskDateFilter, resolveTaskDateFilter, taskMatchesDateRange, type TaskDateRange } from '../lib/taskDateFilter'

test('near-week runs from one week before today through today, including across month, year and DST boundaries', () => {
  for (const [today, start] of [['2026-11-18', '2026-11-11'], ['2026-11-26', '2026-11-19'], ['2027-01-04', '2026-12-28'],
    ['2028-03-03', '2028-02-25'], ['2026-03-10', '2026-03-03'], ['2026-11-03', '2026-10-27']]) {
    const range = resolveTaskDateFilter({ kind: 'week' }, today)!
    assert.deepEqual(range, { field: 'end', from: start, to: today })
    assert.equal(taskMatchesDateRange({ end_date: `${start}T00:00:00` }, range), true)
    assert.equal(taskMatchesDateRange({ end_date: `${today}T23:59:59` }, range), true)
  }
  const range = resolveTaskDateFilter({ kind: 'week' }, '2026-11-18')!
  for (const end_date of ['2026-11-10T23:59:59', '2026-11-19T00:00:00', '2026-11-24', null, '', 'broken']) {
    assert.equal(taskMatchesDateRange({ start_date: '2026-11-17', end_date }, range), false)
  }
  assert.equal(taskMatchesDateRange({ end_date: '2026-11-17T23:59:59' }, range), true)
  assert.deepEqual(resolveTaskDateFilter({ kind: 'week' }, '2026-11-19'), { field: 'end', from: '2026-11-12', to: '2026-11-19' })
  assert.equal(resolveTaskDateFilter(null, '2026-11-18'), null)
})

test('custom date ranges match start, end or either endpoint, never mere overlap', () => {
  const tasks = [
    { start_date: '2026-11-18', end_date: '2026-11-19' },
    { start_date: '2026-11-10', end_date: '2026-11-18T23:59:59' },
    { start_date: '2026-11-20T23:59:59', end_date: '2026-11-22' },
    { start_date: '2026-11-10', end_date: '2026-11-22' },
    { start_date: null, end_date: '2026-11-20 09:00:00' },
    { start_date: '2026-11-20', end_date: null },
    { start_date: null, end_date: null },
  ]
  for (const [field, expected] of [
    ['start', [true, false, true, false, false, true, false]],
    ['end', [true, true, false, false, true, false, false]],
    ['either', [true, true, true, false, true, true, false]],
  ] as const) {
    const range = resolveTaskDateFilter({ kind: 'custom', field, from: '2026-11-18', to: '2026-11-20' }, '2030-01-01')!
    assert.deepEqual(tasks.map(task => taskMatchesDateRange(task, range)), expected)
  }
})

test('single-day ranges include all times, preserve task calendar dates and reject missing or malformed dates', () => {
  const range: TaskDateRange = { field: 'either', from: '2028-02-29', to: '2028-02-29' }
  for (const value of ['2028-02-29', '2028-02-29T00:00:00', '2028-02-29 23:59:59']) {
    assert.equal(taskMatchesDateRange({ start_date: value }, range), true)
    assert.equal(taskMatchesDateRange({ end_date: value }, range), true)
  }
  for (const value of ['', '2028-02-30', '2028-02-29junk', '2028-03-01', null, undefined]) {
    assert.equal(taskMatchesDateRange({ start_date: value, end_date: value }, range), false)
  }
})

test('date filter validation rejects reversed, incomplete, impossible and unsupported filters', () => {
  assert.equal(normalizeTaskDateFilter(undefined), null)
  assert.equal(normalizeTaskDateFilter(null), null)
  assert.deepEqual(normalizeTaskDateFilter({ kind: 'week', from: 'old-date' }), { kind: 'week' })
  const valid = { kind: 'custom', field: 'either', from: '2028-02-29', to: '2028-03-01' }
  assert.deepEqual(normalizeTaskDateFilter({ ...valid, tasks: [1] }), valid)
  for (const value of [false, [], {}, { kind: 'month' }, { ...valid, field: 'overlap' }, { ...valid, from: '2026-02-29' },
    { ...valid, to: '' }, { ...valid, to: '2028-02-28' }, { ...valid, from: '2028-2-29' }, { ...valid, from: 20280229 }]) {
    assert.equal(normalizeTaskDateFilter(value), undefined, JSON.stringify(value))
  }
})
