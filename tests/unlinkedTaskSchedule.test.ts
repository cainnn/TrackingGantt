import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Task, Dependency } from '../types'
import { planUnlinkedTaskStarts } from '../lib/unlinkedTaskSchedule'
import { addMinutesStr } from '../lib/clientTime'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, labelDraftStep, undoDraft, redoDraft } from '../store/draftHistory'
import { setTasks, updateTasks, markDirty } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'

const dep = (from: string, to: string, extra: Partial<Dependency> = {}): Dependency => ({ id: `${from}-${to}`, project_id: 'p', from_task_id: from, to_task_id: to, type: 2, lag: 0, active: true, ...extra })
function fixture(isMinute: boolean) {
  const unit = isMinute ? 60 : 1440
  const anchor = isMinute ? '2030-01-01T09:17:00' : '2030-01-01T00:00:00'
  const at = (n: number) => addMinutesStr(anchor, n * unit)!
  const task = (id: string, start: number, duration: number, extra: Partial<Task> = {}): Task => ({ id, parent_id: null, project_id: 'p', task_code: id, name: id,
    assignee: null, start_date: at(start), end_date: at(start + duration), duration: duration * unit,
    duration_unit: isMinute ? 'minute' : 'day', percent_done: 0, auto_schedule: true, constraint_type: 'asap', is_milestone: false,
    note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra })
  return { at, task, unit, options: { isMinute, anchorDate: anchor } }
}
for (const minute of [false, true]) {
  test(`unlinked future tasks align together, preserve duration and roll up parents and downstream summaries (${minute})`, () => {
    const { task, at, unit, options } = fixture(minute)
    const tasks = [task('a', 4, 2, { parent_id: 'p' }), task('b', 7, 5, { parent_id: 'p' }), task('p', 4, 8),
      task('c', 12, 1, { parent_id: 'q' }), task('q', 12, 1), task('d', 13, 1), task('milestone', 10, 0, { is_milestone: true })]
    const dependencies = [dep('p', 'c'), dep('q', 'd')]
    const before = JSON.stringify({ tasks, dependencies })
    const plan = planUnlinkedTaskStarts(tasks, dependencies, options)
    for (const [id, start, duration] of [['a', 0, 2], ['b', 0, 5], ['p', 0, 5], ['c', 5, 1], ['q', 5, 1], ['d', 6, 1], ['milestone', 0, 0]] as const) {
      const result = plan.tasks.find(t => t.id === id)!
      assert.equal(result.start_date, at(start), id)
      assert.equal(result.end_date, at(start + duration), id)
      assert.equal(result.duration, duration * unit, id)
    }
    assert.deepEqual(plan.directTaskIds.sort(), ['a', 'b', 'milestone'])
    assert.equal(JSON.stringify({ tasks, dependencies }), before, 'preview never mutates inputs')
    assert.deepEqual(planUnlinkedTaskStarts(plan.tasks, dependencies, options).updatedTasks, [], 'confirmation does not prompt twice')
  })
  test(`manual, inactive, inherited-inactive, date-constrained and historical roots are preserved (${minute})`, () => {
    const { task, options } = fixture(minute)
    const tasks = [task('past', -2, 1), task('today', 0, 1), task('manual', 5, 1, { auto_schedule: false }),
      task('inactive', 5, 1, { inactive: true }), task('child', 5, 1, { parent_id: 'inactive' }),
      ...['muststarton', 'mustfinishon', 'startnoearlierthan', 'finishnoearlierthan', 'startnolaterthan', 'finishnolaterthan', 'alap'].map(type => task(type, 5, 1, { constraint_type: type as Task['constraint_type'], constraint_date: options.anchorDate })),
      task('deleted', 5, 1, { is_deleted: true }), task('missing-dates', 5, 1, { start_date: null }), task('backwards', 5, -1)]
    assert.deepEqual(planUnlinkedTaskStarts(tasks, [], options).updatedTasks, [])
  })
  test(`every effective dependency type protects its target from direct anchoring (${minute})`, () => {
    const { task, options } = fixture(minute)
    for (const type of [0, 1, 2, 3] as const) {
      const tasks = [task('source', -2, 1), task('target', 5, 1)]
      assert.deepEqual(planUnlinkedTaskStarts(tasks, [dep('source', 'target', { type, lag: 10 })], options).updatedTasks, [])
    }
  })
  test(`inactive and ancestor links do not prevent unlinked task alignment (${minute})`, () => {
    const { task, at, options } = fixture(minute)
    const tasks = [task('p', 5, 1), task('a', 5, 1, { parent_id: 'p' }), task('b', 5, 1), task('inactive', 5, 1, { inactive: true })]
    const plan = planUnlinkedTaskStarts(tasks, [dep('p', 'a'), dep('a', 'b', { active: false }), dep('inactive', 'b')], options)
    assert.equal(plan.tasks.find(t => t.id === 'a')?.start_date, at(0))
    assert.equal(plan.tasks.find(t => t.id === 'b')?.start_date, at(0))
    assert.equal(plan.tasks.find(t => t.id === 'inactive')?.start_date, at(5))
  })
  test(`manual boundaries and stronger predecessors remain authoritative during cascade (${minute})`, () => {
    const { task, at, options } = fixture(minute)
    const tasks = [task('a', 5, 1), task('m', 6, 1, { auto_schedule: false }), task('n', 7, 1),
      task('bound', 6, 1, { constraint_type: 'startnoearlierthan', constraint_date: at(4) }), task('join', 7, 1)]
    const plan = planUnlinkedTaskStarts(tasks, [dep('a', 'm'), dep('m', 'n'), dep('a', 'bound'), dep('bound', 'join'), dep('m', 'join')], options)
    for (const [id, start] of [['a', 0], ['m', 6], ['n', 7], ['bound', 4], ['join', 7]] as const) assert.equal(plan.tasks.find(t => t.id === id)?.start_date, at(start), id)
  })
}

test('confirmed alignment is one undo step, retaining the entire unsaved plan and dependency graph', async () => {
  const { task, options } = fixture(false)
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: '2029-12-01', created_at: '' }))
  store.dispatch(setTasks({ tasks: [task('a', 5, 1), task('b', 6, 1)], dependencies: [dep('a', 'b')] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[0], name: 'My draft' }]))
  await Promise.resolve()
  const before = snapshotDraft(store.getState()), plan = planUnlinkedTaskStarts(before.tasks, before.dependencies, options)
  store.dispatch(labelDraftStep({ label: '保存前对齐无前置任务', directTaskIds: plan.directTaskIds }))
  store.dispatch(updateTasks(plan.updatedTasks)); store.dispatch(markDirty(plan.directTaskIds))
  await Promise.resolve()
  const aligned = snapshotDraft(store.getState())
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), before)
  store.dispatch(redoDraft()); assert.deepEqual(snapshotDraft(store.getState()), aligned)
})
