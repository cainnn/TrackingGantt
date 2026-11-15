import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Task, Dependency } from '../types'
import { planTaskDeletion } from '../lib/taskDeletion'
import { buildSaveDiff } from '../lib/clientSave'
import { createDraftMiddleware, rootReducer, initializeDraft, labelDraftStep, snapshotDraft, undoDraft, redoDraft } from '../store/draftHistory'
import { deleteTasks, setTasks } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'
import { addMinutesStr } from '../lib/clientTime'

const anchor = '2026-11-12T00:00:00'
const options = { deletionDate: anchor, operationId: '12345678-1234-4321-8123-123456789012', isMinute: true }
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, parent_id: null, project_id: 'p', task_code: id, name: id,
  assignee: null, start_date: '2026-12-01T00:00:00', end_date: '2026-12-03T00:00:00', duration: 2880,
  duration_unit: 'minute', percent_done: 0, auto_schedule: true, constraint_type: 'asap', is_milestone: false,
  note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra })
const dep = (from: string, to: string, extra: Partial<Dependency> = {}): Dependency => ({ id: `${from}-${to}`,
  project_id: 'p', from_task_id: from, to_task_id: to, type: 2, lag: 0, active: true, ...extra })
const edges = (deps: Dependency[]) => deps.map(d => [d.from_task_id, d.to_task_id, d.type, d.lag, d.active !== false])

function parallelPredecessors(isMinute = false, autoSchedule = true) {
  const start = isMinute ? '2030-01-01T09:15:00' : '2030-01-01T00:00:00'
  const unit = isMinute ? 60 : 1440
  const at = (offset: number) => addMinutesStr(start, offset * unit)!
  const tasks = [task('a', { start_date: start, end_date: at(1), duration: unit }),
    task('b', { start_date: start, end_date: at(2), duration: 2 * unit }),
    task('c', { start_date: start, end_date: at(3), duration: 3 * unit }),
    task('d', { start_date: at(3), end_date: at(4), duration: unit, auto_schedule: autoSchedule }),
    task('e', { start_date: at(4), end_date: at(5), duration: unit, auto_schedule: autoSchedule })]
  const dependencies = [dep('a', 'd'), dep('b', 'd'), dep('c', 'd'), dep('d', 'e')]
  return { tasks, dependencies, at, unit }
}

for (const isMinute of [false, true]) {
  test(`deleting the longest of three parallel predecessors collapses D to B's finish and cascades (${isMinute ? 'minute' : 'day'})`, () => {
    const { tasks, dependencies, at, unit } = parallelPredecessors(isMinute)
    const unrelated = task('unrelated', { constraint_type: 'muststarton', constraint_date: '2035-01-01T00:00:00' })
    const result = planTaskDeletion([...tasks, unrelated], dependencies, ['c'], { ...options, isMinute })
    const byId = new Map(result.tasks.map(t => [t.id, t]))
    assert.equal(byId.get('d')?.start_date, at(2))
    assert.equal(byId.get('d')?.end_date, at(3))
    assert.equal(byId.get('e')?.start_date, at(3))
    assert.equal(byId.get('e')?.end_date, at(4))
    for (const id of ['d', 'e']) {
      assert.equal(byId.get(id)?.duration, unit)
      assert.equal(byId.get(id)?.auto_schedule, true)
    }
    for (const id of ['a', 'b']) assert.strictEqual(byId.get(id), tasks.find(t => t.id === id))
    assert.strictEqual(byId.get('unrelated'), unrelated)
    assert.deepEqual(result.dependencies, dependencies.filter(d => d.from_task_id !== 'c'))
    assert.deepEqual(result.updatedTasks.map(t => t.id).sort(), ['d', 'e'])

    const second = planTaskDeletion(result.tasks, result.dependencies, ['b'], { ...options, isMinute })
    assert.equal(second.tasks.find(t => t.id === 'd')?.start_date, at(1))
    assert.equal(second.tasks.find(t => t.id === 'e')?.start_date, at(2))
  })

  test(`collapse propagates through D, E, F and G regardless of dependency order (${isMinute ? 'minute' : 'day'})`, () => {
    const { tasks, dependencies, at, unit } = parallelPredecessors(isMinute)
    tasks.push(task('f', { start_date: at(5), end_date: at(6), duration: unit }),
      task('g', { start_date: at(6), end_date: at(7), duration: unit }))
    dependencies.push(dep('e', 'f'), dep('f', 'g'))
    const result = planTaskDeletion(tasks, [...dependencies].reverse(), ['c'], { ...options, isMinute })
    for (const [offset, id] of ['d', 'e', 'f', 'g'].entries()) {
      const shifted = result.tasks.find(t => t.id === id)!
      assert.equal(shifted.start_date, at(2 + offset), id)
      assert.equal(shifted.end_date, at(3 + offset), id)
      assert.equal(shifted.duration, unit, id)
    }
    assert.deepEqual(result.updatedTasks.map(t => t.id).sort(), ['d', 'e', 'f', 'g'])
    assert.deepEqual(result.dependencies, [...dependencies].reverse().filter(d => d.from_task_id !== 'c'))
  })
}

test('cascade stops at a downstream manual task and preserves its automatic successor dates', () => {
  const { tasks, dependencies, at, unit } = parallelPredecessors()
  tasks.push(task('f', { start_date: at(5), end_date: at(6), duration: unit, auto_schedule: false }),
    task('g', { start_date: at(6), end_date: at(7), duration: unit }))
  dependencies.push(dep('e', 'f'), dep('f', 'g'))
  const result = planTaskDeletion(tasks, dependencies, ['c'], options)
  assert.equal(result.tasks.find(t => t.id === 'd')?.start_date, at(2))
  assert.equal(result.tasks.find(t => t.id === 'e')?.start_date, at(3))
  assert.strictEqual(result.tasks.find(t => t.id === 'f'), tasks.find(t => t.id === 'f'))
  assert.strictEqual(result.tasks.find(t => t.id === 'g'), tasks.find(t => t.id === 'g'))
  assert.deepEqual(result.updatedTasks.map(t => t.id).sort(), ['d', 'e'])
})

test('a downstream join still waits for its other predecessor after D collapses', () => {
  const { tasks, dependencies, at, unit } = parallelPredecessors()
  const joined = tasks.map(t => t.id === 'e' ? { ...t, start_date: at(6), end_date: at(7) } : t)
  joined.push(task('x', { start_date: at(0), end_date: at(6), duration: 6 * unit }),
    task('f', { start_date: at(7), end_date: at(8), duration: unit }))
  dependencies.push(dep('x', 'e'), dep('e', 'f'))
  const result = planTaskDeletion(joined, dependencies, ['c'], options)
  assert.equal(result.tasks.find(t => t.id === 'd')?.start_date, at(2))
  assert.equal(result.tasks.find(t => t.id === 'e')?.start_date, at(6))
  assert.equal(result.tasks.find(t => t.id === 'f')?.start_date, at(7))
  assert.deepEqual(result.updatedTasks.map(t => t.id), ['d'])
})

test('a manual successor keeps its dates after a parallel predecessor is deleted', () => {
  const { tasks, dependencies, at } = parallelPredecessors(false, false)
  const result = planTaskDeletion(tasks, dependencies, ['c'], options)
  assert.equal(result.tasks.find(t => t.id === 'd')?.start_date, at(3))
  assert.equal(result.tasks.find(t => t.id === 'e')?.start_date, at(4))
  assert.equal(result.tasks.find(t => t.id === 'd')?.auto_schedule, false)
  assert.deepEqual(result.updatedTasks, [])
})

test('deleting a shorter parallel predecessor keeps dates, while remaining lag and hard constraints still control the collapse', () => {
  const { tasks, dependencies, at, unit } = parallelPredecessors()
  const unchanged = planTaskDeletion(tasks, dependencies, ['a'], options)
  assert.equal(unchanged.tasks.find(t => t.id === 'd')?.start_date, at(3))
  assert.deepEqual(unchanged.updatedTasks, [])

  const lagged = dependencies.map(d => d.from_task_id === 'b' ? { ...d, lag: unit } : d)
  const result = planTaskDeletion(tasks, lagged, ['c'], options)
  assert.equal(result.tasks.find(t => t.id === 'd')?.start_date, at(3))

  const constrained = tasks.map(t => t.id === 'd' ? { ...t, constraint_type: 'startnoearlierthan', constraint_date: at(3) } : t)
  assert.equal(planTaskDeletion(constrained, dependencies, ['c'], options).tasks.find(t => t.id === 'd')?.start_date, at(3))
})

test('shortened summaries propagate through successive dependency and summary levels while manual tasks stay fixed', () => {
  const { tasks, at } = parallelPredecessors()
  const nested = tasks.map(t => ['a', 'b', 'c'].includes(t.id) ? { ...t, parent_id: 'summary' }
    : t.id === 'd' ? { ...t, parent_id: 'next-summary' } : t)
  nested.push(task('summary', { start_date: at(0), end_date: at(3), duration: 3 * 1440 }))
  nested.push(task('next-summary', { start_date: at(3), end_date: at(4), duration: 1440 }))
  const dependencies = [dep('summary', 'd'), dep('next-summary', 'e')]
  const result = planTaskDeletion(nested, dependencies, ['c'], options)
  assert.equal(result.tasks.find(t => t.id === 'summary')?.end_date, at(2))
  assert.equal(result.tasks.find(t => t.id === 'd')?.start_date, at(2))
  assert.equal(result.tasks.find(t => t.id === 'next-summary')?.end_date, at(3))
  assert.equal(result.tasks.find(t => t.id === 'e')?.start_date, at(3))

  const manual = nested.map(t => t.id === 'd' ? { ...t, auto_schedule: false } : t)
  const manualResult = planTaskDeletion(manual, dependencies, ['c'], options)
  assert.equal(manualResult.tasks.find(t => t.id === 'summary')?.end_date, at(2))
  assert.equal(manualResult.tasks.find(t => t.id === 'd')?.start_date, at(3))
  assert.equal(manualResult.tasks.find(t => t.id === 'next-summary')?.end_date, at(4))
  assert.equal(manualResult.tasks.find(t => t.id === 'e')?.start_date, at(4))
})

test('parallel predecessor collapse is one undoable draft step and saves every shifted successor', async () => {
  const { tasks, dependencies, at, unit } = parallelPredecessors()
  tasks.push(task('f', { start_date: at(5), end_date: at(6), duration: unit }),
    task('g', { start_date: at(6), end_date: at(7), duration: unit }))
  dependencies.push(dep('e', 'f'), dep('f', 'g'))
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null,
    status_date: '2025-01-01', planning_status: 'draft', created_at: '' }))
  store.dispatch(setTasks({ tasks, dependencies }))
  const baseline = snapshotDraft(store.getState())
  store.dispatch(initializeDraft({ projectId: 'p', baseline }))
  store.dispatch(labelDraftStep('删除任务及子任务'))
  store.dispatch(deleteTasks(['c'], options))
  await Promise.resolve()
  const after = snapshotDraft(store.getState())
  assert.equal(after.tasks.find(t => t.id === 'd')?.start_date, at(2))
  assert.equal(after.tasks.find(t => t.id === 'e')?.start_date, at(3))
  assert.equal(after.tasks.find(t => t.id === 'f')?.start_date, at(4))
  assert.equal(after.tasks.find(t => t.id === 'g')?.start_date, at(5))
  assert.equal(store.getState().draft.past.length, 1)
  assert.deepEqual([...store.getState().tasks.dirtyIds].sort(), ['d', 'e', 'f', 'g'])
  const diff = buildSaveDiff(tasks, dependencies, after.tasks, after.dependencies)
  assert.deepEqual(diff.tasksToDelete, ['c'])
  assert.deepEqual(diff.tasksToUpdate.map(t => t.id).sort(), ['d', 'e', 'f', 'g'])
  assert.deepEqual(diff.depsToAdd, [])
  assert.deepEqual(diff.depsToUpdate, [])
  assert.deepEqual(diff.depsToDelete, [])
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), baseline)
  store.dispatch(redoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), after)
})

test('deleting an intermediate activity preserves predecessor/successor links and removes its work duration', () => {
  const tasks = [task('a'), task('deleted'), task('c')], deps = [dep('a', 'deleted', { lag: 60 }), dep('deleted', 'c', { lag: 30 })]
  const before = structuredClone({ tasks, deps })
  const result = planTaskDeletion(tasks, deps, ['deleted'], options)
  assert.deepEqual(edges(result.dependencies), [['a', 'c', 2, 90, true]])
  assert.equal(result.tasks.find(t => t.id === 'c')?.start_date, '2026-12-03T01:30:00')
  assert.deepEqual({ tasks, deps }, before)
})

test('all sixteen combinations retain outer start/finish events and signed lag in minutes', () => {
  for (let incoming = 0; incoming < 4; incoming++) for (let outgoing = 0; outgoing < 4; outgoing++) {
    const result = planTaskDeletion([task('a'), task('d'), task('c')],
      [dep('a', 'd', { type: incoming, lag: 80 }), dep('d', 'c', { type: outgoing, lag: -20 })], ['d'], options)
    assert.deepEqual(edges(result.dependencies), [['a', 'c', (incoming & 2) | (outgoing & 1), 60, true]], `${incoming}/${outgoing}`)
  }
})

test('batch deletion reconnects multiple incoming/outgoing paths across all deleted activities', () => {
  const tasks = ['a', 'b', 'd1', 'd2', 'c', 'e', 'x', 'y'].map(id => task(id))
  const deps = [dep('a', 'd1'), dep('b', 'd1', { lag: 10 }), dep('d1', 'd2', { lag: 20 }),
    dep('d2', 'c', { lag: 30 }), dep('d2', 'e'), dep('x', 'y')]
  const first = planTaskDeletion(tasks, deps, ['d1', 'd2'], options)
  const second = planTaskDeletion(tasks, [...deps].reverse(), ['d2', 'd1'], options)
  assert.deepEqual(edges(first.newDependencies), edges(second.newDependencies))
  assert.deepEqual(edges(first.newDependencies), [['a', 'c', 2, 50, true], ['a', 'e', 2, 20, true],
    ['b', 'c', 2, 60, true], ['b', 'e', 2, 30, true]])
  assert.strictEqual(first.dependencies.find(d => d.id === 'x-y'), deps.at(-1))
})

test('an existing direct relation is retained exactly and overlapping replacement paths are deduplicated', () => {
  const original = dep('a', 'c', { type: 0, lag: 70, active: false })
  const tasks = ['a', 'd1', 'd2', 'c'].map(id => task(id))
  const paths = [dep('a', 'd1'), dep('d1', 'c', { lag: 5 }), dep('a', 'd2'), dep('d2', 'c', { lag: 40 })]
  const kept = planTaskDeletion(tasks, [original, ...paths], ['d1', 'd2'], options)
  assert.deepEqual(kept.dependencies, [original])
  const merged = planTaskDeletion(tasks, paths, ['d1', 'd2'], options)
  assert.deepEqual(edges(merged.dependencies), [['a', 'c', 2, 40, true]])
})

test('a newly orphaned successor uses the deletion day and cascades while preserving its duration and other task data', () => {
  const tasks = [task('d'), task('c', { parent_id: 'summary', assignee: '张三', note: '保留备注', percent_done: 35, custom_values: { server: '3' } }),
    task('e', { parent_id: 'summary', duration: 1440, end_date: '2026-12-02T00:00:00' }), task('summary')]
  const result = planTaskDeletion(tasks, [dep('d', 'c'), dep('c', 'e')], ['d'], options)
  const c = result.tasks.find(t => t.id === 'c')!
  assert.equal(c.start_date, anchor)
  assert.equal(c.end_date, '2026-11-14T00:00:00')
  assert.equal(c.duration, 2880)
  assert.equal(c.percent_done, 35)
  assert.equal(c.assignee, '张三'); assert.equal(c.note, '保留备注'); assert.deepEqual(c.custom_values, { server: '3' })
  assert.equal(result.tasks.find(t => t.id === 'e')?.start_date, '2026-11-14T00:00:00')
  assert.equal(result.tasks.find(t => t.id === 'summary')?.end_date, '2026-11-15T00:00:00')
})

test('retained predecessors continue to determine the successor date instead of the deletion day', () => {
  const tasks = [task('d'), task('a', { auto_schedule: false }), task('c')]
  const result = planTaskDeletion(tasks, [dep('d', 'c'), dep('a', 'c')], ['d'], options)
  assert.equal(result.tasks.find(t => t.id === 'c')?.start_date, '2026-12-03T00:00:00')
  assert.deepEqual(edges(result.dependencies), [['a', 'c', 2, 0, true]])
})

test('orphaning explicitly resets manual or earlier planned tasks without changing the manual scheduling flag', () => {
  for (const extra of [{ auto_schedule: false }, { start_date: '2026-10-01T00:00:00', end_date: '2026-10-03T00:00:00' }]) {
    const result = planTaskDeletion([task('d'), task('c', extra)], [dep('d', 'c')], ['d'], options)
    assert.equal(result.tasks[0].start_date, anchor)
    assert.equal(result.tasks[0].duration, 2880)
    assert.equal(result.tasks[0].auto_schedule, extra.auto_schedule ?? true)
  }
})

test('minute projects use the deletion minute, milestones keep zero duration and explicit hard constraints remain effective', () => {
  const result = planTaskDeletion([task('d'), task('c', { is_milestone: true }),
    task('fixed', { constraint_type: 'muststarton', constraint_date: '2026-12-15T09:15:00' })],
    [dep('d', 'c'), dep('d', 'fixed')], ['d'], { ...options, deletionDate: '2026-11-12T16:25:00' })
  const milestone = result.tasks.find(t => t.id === 'c')!
  assert.equal(milestone.start_date, '2026-11-12T16:25:00'); assert.equal(milestone.end_date, milestone.start_date)
  assert.equal(milestone.duration, 0)
  assert.equal(result.tasks.find(t => t.id === 'fixed')?.start_date, '2026-12-15T09:15:00')
})

test('inactive relations and inactive tasks are retained as inactive without activating a deleted path', () => {
  for (const mode of ['edge', 'task']) {
    const result = planTaskDeletion([task('a'), task('d', { inactive: mode === 'task' }), task('c')],
      [dep('a', 'd', { active: mode !== 'edge' }), dep('d', 'c')], ['d'], options)
    assert.equal(result.dependencies[0].active, false)
    assert.equal(result.tasks.find(t => t.id === 'c')?.start_date, mode === 'task' ? '2026-12-01T00:00:00' : anchor)
  }
})

test('retained children attach to their nearest surviving ancestor and keep their mutual dependency', () => {
  const tasks = [task('root'), task('p', { parent_id: 'root' }), task('q', { parent_id: 'p' }),
    task('c', { parent_id: 'q' }), task('e', { parent_id: 'q' })]
  const result = planTaskDeletion(tasks, [dep('c', 'e')], ['p', 'q'], { ...options, includeDescendants: false })
  assert.equal(result.tasks.find(t => t.id === 'c')?.parent_id, 'root')
  assert.equal(result.tasks.find(t => t.id === 'e')?.parent_id, 'root')
  assert.deepEqual(edges(result.dependencies), [['c', 'e', 2, 0, true]])
})

test('deleting a branch includes hidden grandchildren and bridges only valid surviving leaf endpoints', () => {
  const tasks = [task('a'), task('p'), task('d', { parent_id: 'p' }), task('g', { parent_id: 'd' }), task('c')]
  const result = planTaskDeletion(tasks, [dep('a', 'g'), dep('g', 'c')], ['p'], options)
  assert.deepEqual([...result.deletedIds].sort(), ['d', 'g', 'p'])
  assert.deepEqual(edges(result.dependencies), [['a', 'c', 2, 0, true]])
})

test('unrelated constrained tasks, their links and the inputs remain unchanged', () => {
  const untouched = task('unrelated', { constraint_type: 'muststarton', constraint_date: '2030-01-01T00:00:00' })
  const result = planTaskDeletion([task('d'), task('c'), untouched], [dep('d', 'c')], ['d'], options)
  assert.strictEqual(result.tasks.find(t => t.id === 'unrelated'), untouched)
  assert.ok(!result.updatedTasks.some(t => t.id === 'unrelated'))
})

test('disabled incoming links alone do not trigger orphaning and invalid cycles cannot introduce self-links', () => {
  const untouched = task('c')
  const result = planTaskDeletion([task('d'), untouched], [dep('d', 'c', { active: false })], ['d'], options)
  assert.strictEqual(result.tasks[0], untouched)
  const cyclic = planTaskDeletion([task('a'), task('d')], [dep('a', 'd'), dep('d', 'a')], ['d'], options)
  assert.deepEqual(cyclic.dependencies, [])
})

test('deleted paths cannot overflow stored lag or create duplicate endpoint pairs', () => {
  assert.throws(() => planTaskDeletion([task('a'), task('d'), task('c')],
    [dep('a', 'd', { lag: 2147483647 }), dep('d', 'c', { lag: 1 })], ['d'], options), /超出/)
})

test('one undo restores deleted tasks, replacement links and dates; redo and save diff retain the same new link IDs', async () => {
  const tasks = ['a', 'd', 'c'].map(id => task(id)), dependencies = [dep('a', 'd'), dep('d', 'c')]
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null,
    status_date: '2025-01-01', planning_status: 'draft', created_at: '' }))
  store.dispatch(setTasks({ tasks, dependencies }))
  const baseline = snapshotDraft(store.getState()); store.dispatch(initializeDraft({ projectId: 'p', baseline }))
  store.dispatch(labelDraftStep('删除任务及子任务'))
  store.dispatch(deleteTasks(['d'], { deletionDate: anchor, isMinute: true })); await Promise.resolve()
  const after = snapshotDraft(store.getState())
  assert.equal(store.getState().draft.past.length, 1)
  const diff = buildSaveDiff(tasks, dependencies, after.tasks, after.dependencies)
  assert.deepEqual(diff.tasksToDelete, ['d']); assert.equal(diff.depsToAdd.length, 1)
  assert.equal(diff.depsToAdd[0].from_task_id, 'a'); assert.equal(diff.depsToAdd[0].to_task_id, 'c')
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), baseline)
  store.dispatch(redoDraft()); assert.deepEqual(snapshotDraft(store.getState()), after)
})
