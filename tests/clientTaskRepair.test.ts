import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Dependency, Task } from '../types'
import { buildTaskRepair } from '../lib/clientTaskRepair'
import { getPlanScheduleIssues } from '../lib/planScheduleValidation'
import { planUnlinkedTaskStarts } from '../lib/unlinkedTaskSchedule'
import { addMinutesStr } from '../lib/clientTime'
import { buildSaveDiff } from '../lib/clientSave'
import { createDraftMiddleware, rootReducer, initializeDraft, snapshotDraft, labelDraftStep, undoDraft, redoDraft, hasDraftChanges } from '../store/draftHistory'
import { markDirty, setTasks, updateTasks } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, project_id: 'p', parent_id: null, task_code: id, name: id, assignee: '负责人',
  start_date: '2026-11-20T00:00:00', end_date: '2026-11-22T00:00:00', duration: 2880, duration_unit: 'day',
  auto_schedule: true, constraint_type: 'asap', percent_done: 0, is_milestone: false, note: '保留备注',
  order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...patch,
})
const dep = (from: string, to: string, patch: Partial<Dependency> = {}): Dependency => ({
  id: `${from}-${to}`, project_id: 'p', from_task_id: from, to_task_id: to, type: 2, lag: 0, ...patch,
})
const apply = (tasks: Task[], updates: Task[]) => tasks.map(task => updates.find(update => update.id === task.id) ?? task)
const repairDay = '2026-11-08'

for (const isMinute of [false, true]) test(`historical automatic successors follow all dependency types and lag, never today's floor (${isMinute})`, () => {
  const start = isMinute ? '2026-11-01T09:15:00' : '2026-11-01T00:00:00'
  const end = isMinute ? '2026-11-02T09:15:00' : '2026-11-02T00:00:00'
  const duration = isMinute ? 95 : 2880
  const bStart = isMinute ? '2026-11-05T11:00:00' : '2026-11-05T00:00:00'
  const tasks = [task('A', { start_date: start, end_date: end, duration: 1440 }),
    task('B', { start_date: bStart, end_date: addMinutesStr(bStart, duration), duration })]
  for (const type of [0, 1, 2, 3]) for (const lag of [0, 1440]) {
    const dependencies = [dep('A', 'B', { type, lag })]
    const expected = addMinutesStr(type & 2 ? end : start, lag - (type & 1 ? duration : 0))
    const result = buildTaskRepair(tasks, dependencies, '2026-11-15T09:17:00', isMinute)
    assert.deepEqual(result.repairedIds, ['B'])
    assert.deepEqual(result.dependencyTaskIds, ['B'])
    assert.deepEqual(result.unlinkedTaskIds, [])
    assert.equal(result.updates[0].start_date, expected, `type ${type}, lag ${lag}`)
    assert.equal(result.updates[0].end_date, addMinutesStr(expected, duration))
    assert.equal(result.updates[0].duration, duration)
    const next = apply(tasks, result.updates)
    assert.deepEqual(next[0], tasks[0])
    assert.deepEqual(buildTaskRepair(next, dependencies, '2026-11-15T09:17:00', isMinute).updates, [])
    const issues = getPlanScheduleIssues(tasks, dependencies, { anchorDate: '2026-11-15', isMinute })
    assert.ok(issues.some(issue => issue.kind === 'dependency-schedule' && issue.taskId === 'B'))
  }
})

test('historical dependency repair uses the latest predecessor, rolls up parents, and respects date limits and manual tasks', () => {
  const tasks = [task('A', { start_date: '2026-11-01', end_date: '2026-11-02', duration: 1440 }),
    task('other', { start_date: '2026-11-01', end_date: '2026-11-04', duration: 4320 }),
    task('parent', { start_date: '2026-11-06', end_date: '2026-11-08' }),
    task('B', { parent_id: 'parent', start_date: '2026-11-06', end_date: '2026-11-08' }),
    task('C', { start_date: '2026-11-08', end_date: '2026-11-10' }),
    task('limited', { start_date: '2026-11-07', end_date: '2026-11-09', constraint_type: 'startnoearlierthan', constraint_date: '2026-11-07' }),
    task('manual', { auto_schedule: false, start_date: '2026-11-05', end_date: '2026-11-07' })]
  const dependencies = [dep('A', 'B'), dep('other', 'B'), dep('parent', 'C'), dep('B', 'limited'), dep('B', 'manual')]
  const result = buildTaskRepair(tasks, dependencies, '2026-11-15')
  const next = apply(tasks, result.updates)
  assert.equal(next[3].start_date, '2026-11-04T00:00:00')
  assert.equal(next[2].start_date, '2026-11-04T00:00:00')
  assert.equal(next[4].start_date, '2026-11-06T00:00:00')
  assert.equal(next[5].start_date, tasks[5].start_date)
  assert.deepEqual(next[6], tasks[6])
  assert.deepEqual(buildTaskRepair(next, dependencies, '2026-11-15').updates, [])
})

test('disabled or inactive predecessors leave historical roots intact, and cyclic branches are not date-repaired', () => {
  const tasks = ['A', 'B', 'C', 'D', 'inactive', 'child'].map(id => task(id, { start_date: '2026-11-01', end_date: '2026-11-03',
    ...(id === 'inactive' ? { inactive: true } : id === 'child' ? { parent_id: 'inactive' } : {}) }))
  const dependencies = [dep('A', 'B'), dep('B', 'A'), dep('A', 'C'), dep('B', 'D', { active: false }), dep('child', 'D')]
  assert.deepEqual(buildTaskRepair(tasks, dependencies, '2026-11-15').updates, [])
  assert.ok(getPlanScheduleIssues(tasks, dependencies, { anchorDate: '2026-11-15' }).some(issue => issue.kind === 'cycle'))
})

for (const isMinute of [false, true]) test(`saved plans with no draft changes still expose ASAP problems, preserving historical starts (${isMinute})`, () => {
  const anchorDate = isMinute ? `${repairDay}T09:17:00` : `${repairDay}T00:00:00`
  const tasks = [task('parent'), task('future', { parent_id: 'parent' }),
    task('past', { start_date: '2026-11-07T23:30:00', end_date: '2026-11-21T01:05:00' }),
    task('none', { constraint_type: 'none' }), task('manual', { auto_schedule: false }),
    task('fixed', { constraint_type: 'muststarton', constraint_date: '2026-11-20' }),
    task('inactive', { inactive: true }), task('disabled-link'), task('inactive-source-link'),
    task('deleted', { is_deleted: true }), task('deleted-source-link'), task('successor'),
    task('past-successor', { start_date: '2026-11-07T00:00:00', end_date: '2026-11-09T00:00:00' }),
    task('inactive-child', { parent_id: 'inactive' })].filter(task => !task.is_deleted)
  const dependencies = [dep('parent', 'future'), dep('manual', 'disabled-link', { active: false }),
    dep('inactive', 'inactive-source-link'), dep('deleted', 'deleted-source-link'), dep('future', 'successor')]
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'Saved plan', start_date: '2026-12-01', end_date: null, status_date: '2026-12-01', planning_status: 'stable', created_at: '' }))
  store.dispatch(setTasks({ tasks, dependencies }))
  const baseline = snapshotDraft(store.getState())
  store.dispatch(initializeDraft({ projectId: 'p', baseline }))
  assert.equal(hasDraftChanges(store.getState()), false)
  const options = { anchorDate, isMinute }
  const issues = getPlanScheduleIssues(baseline.tasks, dependencies, options).filter(issue => issue.kind === 'unlinked-start')
  const expected = ['future', 'none', 'disabled-link', 'inactive-source-link', 'deleted-source-link']
  assert.deepEqual(issues.map(issue => issue.taskId), expected)
  assert.ok(issues.every(issue => issue.detail.includes('没有有效前置任务') && issue.detail.includes(repairDay)))
  const repair = buildTaskRepair(baseline.tasks, dependencies, anchorDate, isMinute)
  const saving = planUnlinkedTaskStarts(baseline.tasks, dependencies, options)
  assert.deepEqual(repair.repairedIds, expected)
  assert.deepEqual(repair.updates, saving.updatedTasks)
  assert.deepEqual(snapshotDraft(store.getState()), baseline, 'checking never modifies the saved plan')
  const repaired = apply(baseline.tasks, repair.updates)
  assert.deepEqual(repaired.find(t => t.id === 'past'), tasks[2], 'a historical start with future finish stays intact')
  assert.deepEqual(repaired.find(t => t.id === 'past-successor'), tasks.find(t => t.id === 'past-successor'))
  for (const id of expected) assert.equal(repaired.find(t => t.id === id)?.start_date, anchorDate)
  const reloaded = JSON.parse(JSON.stringify(repaired)) as Task[]
  assert.deepEqual(getPlanScheduleIssues(reloaded, dependencies, options).filter(issue => issue.kind === 'unlinked-start'), [])
  assert.deepEqual(buildTaskRepair(reloaded, dependencies, anchorDate, isMinute).updates, [])
})

test('repair advances future automatic ASAP or unconstrained leaves without effective predecessors', () => {
  const tasks = [task('repair'), task('manual', { auto_schedule: false }), task('none', { constraint_type: 'none' }),
    task('alap', { constraint_type: 'alap' }), task('fixed', { constraint_type: 'muststarton', constraint_date: '2026-11-20' }),
    task('predecessor'), task('disabled-predecessor'), task('inactive', { inactive: true }), task('deleted', { is_deleted: true }),
    task('past', { start_date: '2026-11-01', end_date: '2026-11-03' }),
    task('today', { start_date: repairDay, end_date: '2026-11-10' }),
    task('inactive-parent', { inactive: true }), task('inactive-child', { parent_id: 'inactive-parent' })]
  const dependencies = [dep('manual', 'predecessor'), dep('manual', 'disabled-predecessor', { active: false })]
  const copy = structuredClone(tasks)
  const result = buildTaskRepair(tasks, dependencies, repairDay)
  assert.deepEqual(result.repairedIds, ['repair', 'none', 'disabled-predecessor', 'predecessor'])
  assert.deepEqual(result.updates, [tasks[0], tasks[2], tasks[6]].map(task => ({ ...task, start_date: '2026-11-08T00:00:00', end_date: '2026-11-10T00:00:00' })).concat({ ...tasks[5], start_date: '2026-11-22T00:00:00', end_date: '2026-11-24T00:00:00', original_start_date: null, original_end_date: null }).sort((a, b) => tasks.findIndex(t => t.id === a.id) - tasks.findIndex(t => t.id === b.id)))
  assert.deepEqual(tasks, copy)
})

test('unset scheduling defaults match the editor; missing or reversed dates are not silently invented', () => {
  const result = buildTaskRepair([task('legacy', { auto_schedule: undefined, constraint_type: null }),
    task('missing', { end_date: null }), task('reversed', { end_date: '2026-11-19' })], [], repairDay)
  assert.deepEqual(result.repairedIds, ['legacy'])
  assert.deepEqual(buildTaskRepair([task('a')], [], '').updates, [])
})

test('day repair preserves calendar duration across daylight saving changes', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const result = buildTaskRepair([task('day', { start_date: '2026-10-31', end_date: '2026-11-02' })], [], '2026-10-30')
    assert.equal(result.updates[0].start_date, '2026-10-30T00:00:00')
    assert.equal(result.updates[0].end_date, '2026-11-01T00:00:00')
    assert.equal(result.updates[0].duration, 2880)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('minute repairs match save alignment, retain duration and preserve starts before the anchor', () => {
  const result = buildTaskRepair([
    task('minute', { start_date: '2026-11-20T23:30:00', end_date: '2026-11-21T01:05:00', duration: 95, duration_unit: 'minute' }),
    task('milestone', { start_date: '2026-11-20T09:15:00', end_date: '2026-11-20T09:15:00', duration: 0, is_milestone: true }),
    task('same-day', { start_date: '2026-11-08T08:00:00', end_date: '2026-11-08T09:35:00', duration: 95 }),
  ], [], `${repairDay}T09:17:00`, true)
  assert.deepEqual(result.repairedIds, ['minute', 'milestone'])
  assert.equal(result.updates[0].start_date, '2026-11-08T09:17:00')
  assert.equal(result.updates[0].end_date, '2026-11-08T10:52:00')
  assert.equal(result.updates[0].duration, 95)
  assert.equal(result.updates[1].start_date, result.updates[1].end_date)
  assert.equal(result.updates[1].duration, 0)
})

test('automatic successors follow dependencies and constraints, while manual and unrelated edits stay intact', () => {
  const tasks = [task('root'), task('next'), task('fixed', { constraint_type: 'startnoearlierthan', constraint_date: '2026-11-15' }),
    task('manual', { auto_schedule: false }), task('after-manual'), task('unrelated', { constraint_type: 'muststarton', constraint_date: '2026-11-25' })]
  const dependencies = [dep('root', 'next', { lag: 1440 }), dep('next', 'fixed'), dep('root', 'manual'), dep('manual', 'after-manual')]
  const result = buildTaskRepair(tasks, dependencies, repairDay)
  const next = apply(tasks, result.updates)
  assert.deepEqual(result.repairedIds, ['root', 'after-manual'])
  assert.equal(next[1].start_date, '2026-11-11T00:00:00')
  assert.equal(next[2].start_date, '2026-11-15T00:00:00')
  assert.deepEqual(next[3], tasks[3])
  assert.equal(next[4].start_date, '2026-11-22T00:00:00')
  assert.deepEqual(next[5], tasks[5])
  assert.ok(result.updates.every(task => task.auto_schedule === true && task.duration === 2880))
})

test('summary dates roll up and their automatic successors use the repaired range', () => {
  const tasks = [task('summary'), task('child', { parent_id: 'summary' }), task('next')]
  const result = buildTaskRepair(tasks, [dep('summary', 'next')], repairDay)
  assert.deepEqual(result.repairedIds, ['child'])
  const next = apply(tasks, result.updates)
  assert.equal(next[0].start_date, '2026-11-08T00:00:00')
  assert.equal(next[0].end_date, '2026-11-10T00:00:00')
  assert.equal(next[2].start_date, '2026-11-10T00:00:00')
  assert.equal(next[2].end_date, '2026-11-12T00:00:00')
  assert.deepEqual(buildTaskRepair(next, [dep('summary', 'next')], repairDay).updates, [])
})

test('repair is a single undoable draft, leaves the status date and task attributes intact, and saves actual differences', async () => {
  const tasks = [task('root', { custom_fields: [{ id: 'money', name: '支出', type: 'money' }], custom_values: { money: '120.50' } }), task('next')]
  const dependencies = [dep('root', 'next')]
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: '2026-11-20', end_date: null, status_date: '2026-11-06', planning_status: 'draft', created_at: '' }))
  store.dispatch(setTasks({ tasks, dependencies }))
  const baseline = snapshotDraft(store.getState())
  store.dispatch(initializeDraft({ projectId: 'p', baseline }))
  const result = buildTaskRepair(tasks, dependencies, repairDay)
  store.dispatch(labelDraftStep('修复自动任务开始日期'))
  store.dispatch(updateTasks(result.updates))
  store.dispatch(markDirty(result.repairedIds))
  await Promise.resolve()
  const saved = snapshotDraft(store.getState())
  assert.equal(saved.statusDate, baseline.statusDate)
  assert.deepEqual(saved.tasks[0].custom_values, tasks[0].custom_values)
  assert.deepEqual(saved.dependencies, dependencies)
  assert.equal(store.getState().draft.past.length, 1)
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.deepEqual(buildSaveDiff(tasks, dependencies, saved.tasks, dependencies).tasksToUpdate.map(t => t.id).sort(), ['next', 'root'])
  assert.deepEqual(store.getState().draft.baseline, baseline)
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), baseline)
  store.dispatch(redoDraft()); assert.deepEqual(snapshotDraft(store.getState()), saved)
})
