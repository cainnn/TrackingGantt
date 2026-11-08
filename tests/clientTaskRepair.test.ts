import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Dependency, Task } from '../types'
import { buildTaskRepair } from '../lib/clientTaskRepair'
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

test('repair only advances future automatic ASAP leaf tasks without any configured predecessor', () => {
  const tasks = [task('repair'), task('manual', { auto_schedule: false }), task('none', { constraint_type: 'none' }),
    task('alap', { constraint_type: 'alap' }), task('fixed', { constraint_type: 'muststarton', constraint_date: '2026-11-20' }),
    task('predecessor'), task('disabled-predecessor'), task('inactive', { inactive: true }), task('deleted', { is_deleted: true }),
    task('past', { start_date: '2026-11-01', end_date: '2026-11-03' }),
    task('today', { start_date: repairDay, end_date: '2026-11-10' }),
    task('inactive-parent', { inactive: true }), task('inactive-child', { parent_id: 'inactive-parent' })]
  const dependencies = [dep('manual', 'predecessor'), dep('manual', 'disabled-predecessor', { active: false })]
  const copy = structuredClone(tasks)
  const result = buildTaskRepair(tasks, dependencies, repairDay)
  assert.deepEqual(result.repairedIds, ['repair'])
  assert.deepEqual(result.updates, [{ ...tasks[0], start_date: '2026-11-08T00:00:00', end_date: '2026-11-10T00:00:00' }])
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

test('minute tasks retain time of day and duration; milestones remain zero length', () => {
  const result = buildTaskRepair([
    task('minute', { start_date: '2026-11-20T23:30:00', end_date: '2026-11-21T01:05:00', duration: 95, duration_unit: 'minute' }),
    task('milestone', { start_date: '2026-11-20T09:15:00', end_date: '2026-11-20T09:15:00', duration: 0, is_milestone: true }),
    task('same-day', { start_date: '2026-11-08T23:30:00', end_date: '2026-11-09T01:05:00', duration: 95 }),
  ], [], repairDay, true)
  assert.deepEqual(result.repairedIds, ['minute', 'milestone'])
  assert.equal(result.updates[0].start_date, '2026-11-08T23:30:00')
  assert.equal(result.updates[0].end_date, '2026-11-09T01:05:00')
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
  assert.deepEqual(result.repairedIds, ['root'])
  assert.equal(next[1].start_date, '2026-11-11T00:00:00')
  assert.equal(next[2].start_date, '2026-11-15T00:00:00')
  assert.deepEqual(next.slice(3), tasks.slice(3))
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
