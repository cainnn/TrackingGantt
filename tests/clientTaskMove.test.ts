import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Dependency } from '../types'
import { buildTaskRowMove, taskMoveSelection } from '../lib/clientTaskMove'
import { buildSaveDiff } from '../lib/clientSave'
import { rollupSummaryTasks } from '../lib/clientScheduling'
import { cascadeDragSuccessors } from '../lib/clientDragScheduling'

const task = (id: string, parent_id: string | null, order_index: number): Task => ({ id, project_id: 'p', parent_id, order_index,
  task_code: id, name: id, assignee: null, start_date: '2026-11-01', end_date: '2026-11-03', duration: 2880, duration_unit: 'day',
  percent_done: 0, is_milestone: false, note: '保留备注', is_deleted: false, deleted_at: null, created_at: '', updated_at: '' })
const apply = (tasks: Task[], updates: Task[]) => tasks.map(t => updates.find(u => u.id === t.id) ?? t)
const siblings = (tasks: Task[], parent: string | null = null) => tasks.filter(t => t.parent_id === parent)
  .sort((a, b) => a.order_index - b.order_index).map(t => t.id)

test('dragging up and down reorders siblings while preserving task fields', () => {
  const tasks = [task('a', null, 0), task('b', null, 1), task('c', null, 2)]
  for (const [id, target, position, expected] of [
    ['c', 'a', 'before', ['c', 'a', 'b']], ['a', 'c', 'after', ['b', 'c', 'a']],
  ] as const) {
    const plan = buildTaskRowMove(tasks, [id], target, position)
    assert.equal(plan.invalidReason, '')
    const next = apply(tasks, plan.updates)
    assert.deepEqual(siblings(next), expected)
    for (const row of next) assert.deepEqual({ ...row, order_index: tasks.find(t => t.id === row.id)!.order_index }, tasks.find(t => t.id === row.id))
    assert.deepEqual(buildSaveDiff(tasks, [], next, []).tasksToUpdate, next.filter(t => plan.updates.some(u => u.id === t.id)))
  }
})
test('moving a collapsed parent moves its entire branch without rewriting descendants', () => {
  const tasks = [task('a', null, 0), task('child', 'a', 0), task('grandchild', 'child', 0), task('b', null, 1)]
  const plan = buildTaskRowMove(tasks, ['a'], 'b', 'after')
  const next = apply(tasks, plan.updates)
  assert.deepEqual(siblings(next), ['b', 'a'])
  assert.deepEqual(plan.movedIds, ['a', 'child', 'grandchild'])
  assert.deepEqual(next.slice(1, 3), tasks.slice(1, 3))
})
test('multi-selection preserves tree order and includes descendants only once', () => {
  const tasks = [task('a', null, 0), task('x', 'a', 0), task('b', null, 1), task('c', null, 2), task('d', null, 3)]
  assert.deepEqual(taskMoveSelection(tasks, ['c', 'x', 'a']).roots.map(t => t.id), ['a', 'c'])
  const plan = buildTaskRowMove(tasks, ['c', 'x', 'a'], 'd', 'after')
  assert.deepEqual(siblings(apply(tasks, plan.updates)), ['b', 'd', 'a', 'c'])
  assert.deepEqual(plan.movedIds, ['a', 'x', 'c'])
})
test('cross-level drops reparent roots and compact both sibling groups', () => {
  const tasks = [task('a', null, 0), task('x', 'a', 0), task('y', 'a', 1), task('b', null, 1), task('z', 'b', 0)]
  const plan = buildTaskRowMove(tasks, ['x'], 'z', 'before')
  const next = apply(tasks, plan.updates)
  assert.equal(next.find(t => t.id === 'x')!.parent_id, 'b')
  assert.deepEqual(siblings(next, 'a'), ['y'])
  assert.deepEqual(siblings(next, 'b'), ['x', 'z'])
  assert.equal(next.find(t => t.id === 'y')!.order_index, 0)
})
test('self and descendant drops are rejected without losing any task', () => {
  const tasks = [task('a', null, 0), task('x', 'a', 0), task('y', 'x', 0)]
  for (const target of ['a', 'x', 'y']) for (const position of ['before', 'after'] as const) {
    const plan = buildTaskRowMove(tasks, ['a'], target, position)
    assert.ok(plan.invalidReason)
    assert.deepEqual(plan.updates, [])
  }
})
test('using an actual target retains filtered-out siblings in their correct positions', () => {
  const tasks = [task('a', null, 0), task('hidden', null, 1), task('b', null, 2), task('c', null, 3)]
  const plan = buildTaskRowMove(tasks, ['c'], 'b', 'before')
  assert.deepEqual(siblings(apply(tasks, plan.updates)), ['a', 'hidden', 'c', 'b'])
})
test('unchanged positions, deleted tasks and missing targets do not generate writes', () => {
  const tasks = [task('a', null, 0), task('b', null, 1), { ...task('deleted', null, 2), is_deleted: true }]
  assert.deepEqual(buildTaskRowMove(tasks, ['a'], 'b', 'before').updates, [])
  assert.deepEqual(buildTaskRowMove(tasks, ['deleted'], 'b', 'after').updates, [])
  assert.deepEqual(buildTaskRowMove(tasks, ['a'], 'missing', 'before').updates, [])
})

test('reparenting a task preserves existing relations and reschedules successors of the changed summary', () => {
  const tasks = [task('source', null, 0), { ...task('moved', 'source', 0), end_date: '2026-11-09', duration: 8 * 1440 },
    task('destination', null, 1), task('child', 'destination', 0), { ...task('after', null, 2), start_date: '2026-11-03', end_date: '2026-11-05' }]
  const deps: Dependency[] = [{ id: 'retained', project_id: 'p', from_task_id: 'destination', to_task_id: 'after', type: 2, lag: 0, active: true }]
  const before = structuredClone(deps)
  const move = buildTaskRowMove(tasks, ['moved'], 'child', 'after')
  const updates = new Map(move.updates.map(t => [t.id, t]))
  for (const summary of rollupSummaryTasks(apply(tasks, move.updates))) updates.set(summary.id, summary)
  const linked = cascadeDragSuccessors(tasks, deps, Object.fromEntries(updates), [])
  assert.equal(linked.moved.parent_id, 'destination')
  assert.equal(linked.destination.end_date, '2026-11-09T00:00:00')
  assert.equal(linked.after.start_date, '2026-11-09T00:00:00')
  assert.deepEqual(deps, before)
  const diff = buildSaveDiff(tasks, deps, apply(tasks, Object.values(linked)), deps)
  assert.deepEqual(diff.depsToDelete, [])
  assert.ok(diff.tasksToUpdate.some(t => t.id === 'after'))
})
