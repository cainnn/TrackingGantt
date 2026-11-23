import test from 'node:test'
import assert from 'node:assert/strict'
import { canEditTaskStart, canEditTaskEnd, buildTaskScheduleEdit, defaultTaskSchedule, durationInputValue, hasPastStartDate, resizeTaskSchedule, scheduleDurationMinutes } from '../lib/clientTaskEdit'
import { gridCellEditable } from '../lib/clientGridEdit'
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

test('past-start protection uses calendar dates for day and minute tasks', () => {
  const today = '2026-11-08T09:00:00'
  assert.equal(hasPastStartDate('2026-11-07T23:59:00', today), true)
  assert.equal(hasPastStartDate('2026-11-01', today), true)
  assert.equal(hasPastStartDate('2026-11-08T00:00:00', today), false)
  assert.equal(hasPastStartDate('2026-11-09', today), false)
  assert.equal(hasPastStartDate(null, today), false)
})

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

test('new day tasks and restored milestones have one full day stored in minutes', () => {
  const normal = defaultTaskSchedule('2026-06-01T09:15:00', false)
  assert.deepEqual(normal, {
    start_date: '2026-06-01T00:00:00', end_date: '2026-06-02T00:00:00', duration: 1440,
  })
  const milestone = defaultTaskSchedule(normal.start_date, false, true)
  assert.equal(milestone.duration, 0)
  assert.equal(milestone.start_date, milestone.end_date)
  assert.deepEqual(defaultTaskSchedule(milestone.start_date, false), normal)
})

test('new minute tasks and restored milestones preserve their time with a one-hour default', () => {
  const normal = defaultTaskSchedule('2026-06-01T09:15:00', true)
  assert.deepEqual(normal, {
    start_date: '2026-06-01T09:15:00', end_date: '2026-06-01T10:15:00', duration: 60,
  })
  const milestone = defaultTaskSchedule(normal.start_date, true, true)
  assert.equal(milestone.duration, 0)
  assert.equal(milestone.end_date, '2026-06-01T09:15:00')
  assert.deepEqual(defaultTaskSchedule(milestone.start_date, true), normal)
})

test('resizing a minute task to 45 minutes stays consistent through save', () => {
  const original = task({ start_date: '2026-06-01T09:15:00', end_date: '2026-06-01T10:45:00', duration: 90 })
  const resized = resizeTaskSchedule(original, 'end', '2026-06-01T10:00:00', true)
  assert.equal(resized.end_date, '2026-06-01T10:00:00')
  assert.equal(resized.duration, 45)
  assert.equal(buildSaveDiff([original], [], [resized], []).tasksToUpdate[0].duration, 45)
  const leftResize = resizeTaskSchedule(original, 'start', '2026-06-01T10:00:00', true)
  assert.equal(leftResize.start_date, '2026-06-01T10:00:00')
  assert.equal(leftResize.end_date, original.end_date)
  assert.equal(leftResize.duration, 45)
})

test('resizing across the opposite edge clamps both date and duration to project precision', () => {
  const minuteTask = task({ start_date: '2026-06-01T09:15:00', end_date: '2026-06-01T10:45:00', duration: 90 })
  const right = resizeTaskSchedule(minuteTask, 'end', '2026-06-01T08:00:00', true)
  assert.equal(right.end_date, '2026-06-01T09:30:00')
  assert.equal(right.duration, 15)
  const left = resizeTaskSchedule(minuteTask, 'start', '2026-06-01T11:00:00', true)
  assert.equal(left.start_date, '2026-06-01T10:30:00')
  assert.equal(left.duration, 15)
  const day = resizeTaskSchedule(task(), 'end', '2026-05-30', false)
  assert.equal(day.end_date, '2026-06-02T00:00:00')
  assert.equal(day.duration, 1440)
})

test('date spans used by form and hierarchy edits always return stored minute units', () => {
  assert.equal(scheduleDurationMinutes('2026-06-01', '2026-06-06', false), 7200)
  assert.equal(scheduleDurationMinutes('2026-06-01T09:15:00', '2026-06-01T10:45:00', true), 90)
  assert.equal(scheduleDurationMinutes(null, '2026-06-06', false), null)
  assert.equal(scheduleDurationMinutes('2026-06-06', '2026-06-01', false), -7200)
})

test('unlinked automatic starts are editable by mouse, keyboard and schedule builder without changing mode', () => {
  const original = task({ auto_schedule: true })
  assert.equal(canEditTaskStart(original, []), true)
  assert.equal(gridCellEditable(original, 'start', [original], []), true)
  assert.deepEqual(buildTaskScheduleEdit(original, [], 'start_date', '2026-05-30', false), {
    start_date: '2026-05-30T00:00:00', duration: 7200,
  })
  const minute = task({ auto_schedule: true, start_date: '2026-06-01T09:15:00', end_date: '2026-06-01T10:45:00', duration: 90 })
  assert.deepEqual(buildTaskScheduleEdit(minute, [], 'start_date', '2026-06-01T09:00', true), {
    start_date: '2026-06-01T09:00:00', duration: 105,
  })
})
test('start editability respects all active predecessors, independent of order, and excludes summary dates', () => {
  const original = task({ auto_schedule: true })
  const inactive = [{ ...dependency(2), active: false }]
  assert.equal(canEditTaskStart(original, inactive), true)
  assert.ok(Object.keys(buildTaskScheduleEdit(original, inactive, 'start_date', '2026-05-30', false)).length)
  for (const dependencies of [[dependency(0)], [dependency(2)], [dependency(3), dependency(2)], [dependency(2), dependency(3)]]) {
    assert.equal(canEditTaskStart(original, dependencies), false)
    assert.equal(gridCellEditable(original, 'start', [original], dependencies), false)
    assert.deepEqual(buildTaskScheduleEdit(original, dependencies, 'start_date', '2026-05-30', false), {})
  }
  assert.equal(canEditTaskStart({ ...original, auto_schedule: false }, [dependency(2)]), true)
  assert.equal(canEditTaskStart(original, [dependency(1), dependency(3)]), true)
  assert.equal(gridCellEditable(original, 'start', [original, task({ id: 'child', parent_id: original.id })], []), false)
})
test('editing an unlinked milestone start moves its finish and preserves zero duration', () => {
  const original = task({ is_milestone: true, start_date: '2026-06-01', end_date: '2026-06-01', duration: 0 })
  assert.deepEqual(buildTaskScheduleEdit(original, [], 'start_date', '2026-06-02', false), {
    start_date: '2026-06-02T00:00:00', end_date: '2026-06-02T00:00:00', duration: 0,
  })
})

test('automatic FS/SS finish edits preserve the start, recalculate duration and cascade successors in both precisions', () => {
  for (const isMinute of [false, true]) for (const type of [0, 2]) {
    const at = (day: number) => `2026-06-0${day}T${isMinute ? '09:15' : '00:00'}:00`
    const predecessor = task({ id: 'predecessor', start_date: at(1), end_date: at(2), duration: 1440 })
    const original = task({ auto_schedule: true, start_date: at(type === 0 ? 1 : 2), end_date: at(4), duration: (type === 0 ? 3 : 2) * 1440 })
    const successor = task({ id: 'successor', auto_schedule: true, start_date: at(4), end_date: at(5), duration: 1440 })
    const deps = [dependency(type), { ...dependency(2), id: 'downstream', from_task_id: original.id, to_task_id: successor.id }]
    const tasks = [predecessor, original, successor]
    assert.equal(canEditTaskEnd(original, deps), true)
    assert.equal(gridCellEditable(original, 'end', tasks, deps), true)
    const edited = { ...original, ...buildTaskScheduleEdit(original, deps, 'end_date', at(6), isMinute) }
    assert.equal(edited.start_date, original.start_date)
    assert.equal(edited.end_date, at(6))
    assert.equal(edited.duration, (type === 0 ? 5 : 4) * 1440)
    assert.equal(edited.auto_schedule, true)
    const updates = runFullCascade([predecessor, edited, successor], deps, { isMinute })
    assert.equal(updates.find(t => t.id === successor.id)?.start_date, at(6))
    assert.equal(updates.find(t => t.id === successor.id)?.end_date, at(7))
    assert.equal(buildSaveDiff(tasks, deps, [predecessor, edited, ...updates.filter(t => t.id === successor.id)], deps).tasksToUpdate.find(t => t.id === original.id)?.end_date, at(6))
  }
})

test('finish editability considers all active FF/SF dependencies regardless of order and keeps manual dates editable', () => {
  const original = task({ auto_schedule: true })
  for (const dependencies of [[dependency(1)], [dependency(3)], [dependency(2), dependency(3)], [dependency(3), dependency(2)]]) {
    assert.equal(canEditTaskEnd(original, dependencies), false)
    assert.equal(gridCellEditable(original, 'end', [original], dependencies), false)
    assert.deepEqual(buildTaskScheduleEdit(original, dependencies, 'end_date', '2026-06-06', false), {})
    const manual = { ...original, auto_schedule: false }
    assert.equal(gridCellEditable(manual, 'end', [manual], dependencies), true)
    assert.equal(buildTaskScheduleEdit(manual, dependencies, 'end_date', '2026-06-06', false).end_date, '2026-06-06T00:00:00')
  }
  for (const dependencies of [[], [{ ...dependency(3), active: false }], [{ ...dependency(2), active: false }], [dependency(0), dependency(2)]]) {
    assert.equal(canEditTaskEnd(original, dependencies), true)
    assert.equal(gridCellEditable(original, 'end', [original], dependencies), true)
    assert.equal(buildTaskScheduleEdit(original, dependencies, 'end_date', '2026-06-06', false).duration, 7200)
  }
  const child = task({ id: 'child', parent_id: original.id })
  assert.equal(gridCellEditable(original, 'end', [original, child], []), false)
  assert.equal(gridCellEditable(original, 'end', [original, { ...child, is_deleted: true }], []), true)
})
