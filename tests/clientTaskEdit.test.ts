import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskScheduleEdit, durationInputValue } from '../lib/clientTaskEdit'
import { buildSaveDiff } from '../lib/clientSave'
import { runFullCascade } from '../lib/clientScheduling'
import type { Dependency, Task } from '../types'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', project_id: 'project-1', parent_id: null,
    task_code: '1', name: '工期填报', assignee: null,
    start_date: '2026-06-01T00:00:00', end_date: '2026-06-04T00:00:00',
    duration: 4320, duration_unit: 'minute', percent_done: 0,
    is_milestone: false, note: null, order_index: 0,
    is_deleted: false, deleted_at: null,
    created_at: '2026-06-01T00:00:00', updated_at: '2026-06-01T00:00:00',
    ...overrides,
  }
}

function dependency(type: number): Dependency {
  return {
    id: 'dep-1', project_id: 'project-1',
    from_task_id: 'predecessor', to_task_id: 'task-1', type, lag: 0,
  }
}

test('day-level inline editing opens in days and preserves an unchanged task through save', () => {
  const original = task()
  const input = durationInputValue(original.duration, false)
  assert.equal(input, '3')
  const edited = { ...original, ...buildTaskScheduleEdit(original, [], 'duration', input, false) }
  assert.equal(edited.duration, 4320)
  assert.equal(edited.end_date, '2026-06-04T00:00:00')
  assert.deepEqual(buildSaveDiff([original], [], [edited], []).tasksToUpdate, [])
  assert.equal(durationInputValue(0, false), '0')
  assert.equal(durationInputValue(null, false), '')
})

test('day duration edits keep dates and the saved minute value consistent', () => {
  const original = task({ start_date: '2026-06-01', end_date: '2026-06-04' })
  const edited = { ...original, ...buildTaskScheduleEdit(original, [], 'duration', '5', false) }
  assert.equal(edited.duration, 7200)
  assert.equal(edited.start_date, '2026-06-01')
  assert.equal(edited.end_date, '2026-06-06T00:00:00')
  assert.equal(durationInputValue(edited.duration, false), '5')
  assert.equal(buildSaveDiff([original], [], [edited], []).tasksToUpdate[0].duration, 7200)
})

test('FF and SF duration edits keep the end fixed; FS, SS and manual edits keep the start fixed', () => {
  for (const type of [0, 1, 2, 3]) {
    const patch = buildTaskScheduleEdit(task(), [dependency(type)], 'duration', '2', false)
    assert.deepEqual(patch, type === 1 || type === 3
      ? { duration: 2880, start_date: '2026-06-02T00:00:00' }
      : { duration: 2880, end_date: '2026-06-03T00:00:00' })
  }
  assert.deepEqual(buildTaskScheduleEdit(task({ auto_schedule: false }), [dependency(3)], 'duration', '2', false), {
    duration: 2880, end_date: '2026-06-03T00:00:00',
  })
})

test('date edits store whole-day spans in minutes instead of small day counts', () => {
  assert.deepEqual(buildTaskScheduleEdit(task(), [], 'end_date', '2026-06-06', false), {
    end_date: '2026-06-06T00:00:00', duration: 7200,
  })
  assert.deepEqual(buildTaskScheduleEdit(task({ auto_schedule: false }), [], 'start_date', '2026-06-02', false), {
    start_date: '2026-06-02T00:00:00', duration: 2880,
  })
  assert.deepEqual(buildTaskScheduleEdit(task(), [dependency(3)], 'start_date', '2026-06-02', false), {
    start_date: '2026-06-02T00:00:00', duration: 2880,
  })
  assert.deepEqual(buildTaskScheduleEdit(task(), [dependency(2)], 'start_date', '2026-06-02', false), {})
})

test('day edits use calendar dates across daylight saving changes', () => {
  const previousTZ = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const original = task({ start_date: '2026-03-07', end_date: '2026-03-08', duration: 1440 })
    assert.deepEqual(buildTaskScheduleEdit(original, [], 'duration', '2', false), {
      end_date: '2026-03-09T00:00:00', duration: 2880,
    })
    assert.deepEqual(buildTaskScheduleEdit(original, [], 'end_date', '2026-03-09', false), {
      end_date: '2026-03-09T00:00:00', duration: 2880,
    })
  } finally {
    if (previousTZ == null) delete process.env.TZ
    else process.env.TZ = previousTZ
  }
})

test('minute-level edits preserve the time and keep minute input units', () => {
  const original = task({ start_date: '2026-06-01T09:15:00', end_date: '2026-06-01T10:45:00', duration: 90 })
  assert.equal(durationInputValue(original.duration, true), '90')
  assert.deepEqual(buildTaskScheduleEdit(original, [], 'duration', '45', true), {
    duration: 45, end_date: '2026-06-01T10:00:00',
  })
  assert.deepEqual(buildTaskScheduleEdit(original, [dependency(3)], 'duration', '45', true), {
    duration: 45, start_date: '2026-06-01T10:00:00',
  })
  assert.deepEqual(buildTaskScheduleEdit(original, [], 'end_date', '2026-06-01T11:00', true), {
    end_date: '2026-06-01T11:00:00', duration: 105,
  })
})

test('edited day durations propagate to successors using minutes', () => {
  const predecessor = task({ id: 'predecessor' })
  const successor = task({ start_date: '2026-06-04T00:00:00', end_date: '2026-06-05T00:00:00', duration: 1440 })
  const edited = { ...predecessor, ...buildTaskScheduleEdit(predecessor, [], 'duration', '5', false) }
  const updates = runFullCascade([edited, successor], [dependency(2)], { isMinute: false })
  const moved = updates.find(t => t.id === successor.id)
  assert.equal(moved?.start_date, '2026-06-06T00:00:00')
  assert.equal(moved?.end_date, '2026-06-07T00:00:00')
  assert.equal(moved?.duration, 1440)
})

test('empty, invalid and non-positive inline durations leave the schedule unchanged', () => {
  for (const value of ['', 'invalid', '2days', 'Infinity', '1e308', '-1', '0']) {
    assert.deepEqual(buildTaskScheduleEdit(task(), [], 'duration', value, false), {})
  }
})
