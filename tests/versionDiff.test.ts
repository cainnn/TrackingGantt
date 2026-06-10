import test from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshots, type SnapshotTask } from '../lib/versionDiff'

function task(partial: Partial<SnapshotTask> & Pick<SnapshotTask, 'task_code'>): SnapshotTask {
  return {
    id: partial.id ?? partial.task_code,
    task_code: partial.task_code,
    name: partial.name ?? `任务${partial.task_code}`,
    start_date: partial.start_date ?? '2026-06-01',
    end_date: partial.end_date ?? '2026-06-02',
    duration: partial.duration ?? 1,
    assignee: partial.assignee ?? null,
    percent_done: partial.percent_done ?? 0,
    is_milestone: partial.is_milestone ?? false,
    parent_id: partial.parent_id ?? null,
    order_index: partial.order_index ?? 0,
  }
}

test('day-level diff ignores sub-day date and duration unit noise', () => {
  const oldTasks = [
    task({ task_code: '1', start_date: '2026-06-01', end_date: '2026-06-12', duration: 11 }),
  ]
  const newTasks = [
    task({ task_code: '1', start_date: '2026-06-01T00:39:00', end_date: '2026-06-12T00:39:00', duration: 15840 }),
  ]

  assert.deepEqual(diffSnapshots(oldTasks, newTasks, { isMinute: false }), [])
})

test('day-level diff reports whole-day schedule changes', () => {
  const diffs = diffSnapshots(
    [task({ task_code: '33', start_date: '2026-06-03', end_date: '2026-06-06', duration: 3 })],
    [task({ task_code: '33', start_date: '2026-06-12T00:39:00', end_date: '2026-06-15T00:39:00', duration: 4320 })],
    { isMinute: false },
  )

  assert.equal(diffs.length, 1)
  assert.deepEqual(diffs[0].changes, [
    { field: '开始日期', old: '2026-06-03', new: '2026-06-12' },
    { field: '结束日期', old: '2026-06-06', new: '2026-06-15' },
  ])
})

test('minute-level diff keeps minute changes visible', () => {
  const diffs = diffSnapshots(
    [task({ task_code: '1', start_date: '2026-06-01T00:00:00', end_date: '2026-06-02T00:00:00', duration: 1440 })],
    [task({ task_code: '1', start_date: '2026-06-01T00:39:00', end_date: '2026-06-02T00:39:00', duration: 1440 })],
    { isMinute: true },
  )

  assert.equal(diffs.length, 1)
  assert.deepEqual(diffs[0].changes, [
    { field: '开始日期', old: '2026-06-01 00:00', new: '2026-06-01 00:39' },
    { field: '结束日期', old: '2026-06-02 00:00', new: '2026-06-02 00:39' },
  ])
})
