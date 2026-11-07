import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDependencyTaskLookup, findDependencyTasks } from '../lib/dependencyTaskLookup'
import type { Task } from '../types'

function task(id: number, extra: Partial<Task> = {}): Task {
  return { id: `t${id}`, project_id: 'p', task_code: String(10000 + id), name: `任务 ${id}`, parent_id: null,
    assignee: null, start_date: null, end_date: null, duration: null, duration_unit: 'minute', percent_done: 0,
    is_milestone: false, note: null, order_index: id, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra }
}
function index(tasks: Task[]) { return buildDependencyTaskLookup(tasks, new Map(tasks.map((t, i) => [t.id, i + 1]))) }

test('dependency lookup resolves the displayed number, independent of stored task codes', () => {
  const tasks = [task(1, { task_code: '2' }), task(2, { task_code: '1' })]
  const lookup = index(tasks)
  for (const query of ['2', '#2', ' 002 ']) assert.equal(findDependencyTasks(lookup, query, 'other', new Set()).options[0]?.id, 't2')
  assert.equal(findDependencyTasks(lookup, '200', 'other', new Set()).options.length, 0)
})
test('dependency candidates reject self, deleted tasks and summaries, retaining leaf milestones', () => {
  const tasks = [task(1), task(2, { parent_id: 't1' }), task(3, { is_deleted: true }), task(4, { is_milestone: true })]
  assert.deepEqual(findDependencyTasks(index(tasks), '', 't2', new Set()).options.map(t => t.id), ['t4'])
  for (const query of ['1', '2', '3']) assert.equal(findDependencyTasks(index(tasks), query, 't2', new Set()).options.length, 0)
})
test('large dependency lists stay bounded and exact numbers find tasks beyond the first page', () => {
  const lookup = index(Array.from({ length: 10000 }, (_, i) => task(i + 1)))
  const first = findDependencyTasks(lookup, '', 't1', new Set())
  assert.equal(first.options.length, 30); assert.equal(first.more, true)
  assert.equal(findDependencyTasks(lookup, '9999', 't1', new Set()).options[0]?.id, 't9999')
  const selected = findDependencyTasks(lookup, '', 't1', new Set(['t9999']))
  assert.equal(selected.options[0].id, 't9999'); assert.equal(new Set(selected.options.map(t => t.id)).size, 30)
})
test('task-name filtering is case insensitive and does not leak unrelated selected tasks', () => {
  const lookup = index([task(1, { name: 'CDN 采购' }), task(2, { name: '设备到货' }), task(3, { name: 'cdn 调测' })])
  const found = findDependencyTasks(lookup, 'cDn', 'other', new Set(['t2']))
  assert.deepEqual(found.options.map(t => t.id), ['t1', 't3']); assert.equal(found.more, false)
})
