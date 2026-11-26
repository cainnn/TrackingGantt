import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Dependency } from '../types'
import { buildDependencyGraph, traceDependencyPath } from '../lib/dependencyTrace'

const date = (n: number) => new Date(Date.UTC(2030, 0, 1) + n * 60000).toISOString().slice(0, 19)
function task(id: string, start: number, duration: number, extra: Partial<Task> = {}): Task {
  return { id, project_id: 'p', name: id, task_code: `code-${id}`, parent_id: null, assignee: null, start_date: date(start), end_date: date(start + duration),
    duration, duration_unit: 'minute', percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra }
}
const dep = (from: string, to: string, type = 2, lag = 0, active = true): Dependency => ({ id: `${from}-${to}`, project_id: 'p', from_task_id: from, to_task_id: to, type, lag, active })
const ids = (values: Set<string>) => [...values].sort()

test('driving paths are focus-specific, preserve tied branches, and do not depend on project criticality', () => {
  const tasks = [task('a', 0, 10), task('b', 0, 30), task('c', 0, 30), task('d', 30, 20), task('e', 50, 10), task('unrelated', 0, 1000)]
  const dependencies = [dep('a', 'd'), dep('b', 'd'), dep('c', 'd'), dep('d', 'e')]
  const before = structuredClone({ tasks, dependencies }), graph = buildDependencyGraph(tasks, dependencies)
  assert.deepEqual(graph.links.map(l => l.slackMinutes), [20, 0, 0, 0])
  const backward = traceDependencyPath(graph, 'e', 'driving')
  assert.deepEqual(ids(backward.taskIds), ['b', 'c', 'd', 'e'])
  assert.deepEqual(ids(backward.dependencyIds), ['b-d', 'c-d', 'd-e'])
  assert.deepEqual(backward.warnings, [])
  assert.deepEqual(ids(traceDependencyPath(graph, 'b', 'driven').taskIds), ['b', 'd', 'e'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'd', 'both').taskIds), ['b', 'c', 'd', 'e'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'd', 'upstream').taskIds), ['a', 'b', 'c', 'd'])
  assert.deepEqual({ tasks, dependencies }, before)
})

test('SS, SF, FS and FF use their own endpoints and include signed lag in minutes', () => {
  const fixtures = [
    { type: 0, lag: 15, start: 115, end: 145 },
    { type: 1, lag: 15, start: 85, end: 115 },
    { type: 2, lag: 15, start: 175, end: 205 },
    { type: 3, lag: 15, start: 145, end: 175 },
    { type: 0, lag: -15, start: 85, end: 115 },
    { type: 1, lag: -15, start: 55, end: 85 },
    { type: 2, lag: -15, start: 145, end: 175 },
    { type: 3, lag: -15, start: 115, end: 145 },
  ]
  for (const f of fixtures) {
    const graph = buildDependencyGraph([task('a', 100, 60), task('b', f.start, f.end - f.start)], [dep('a', 'b', f.type, f.lag)])
    assert.equal(graph.links[0].slackMinutes, 0, JSON.stringify(f))
    assert.equal(graph.links[0].status, 'driving')
    assert.deepEqual(ids(traceDependencyPath(graph, 'b', 'driving').taskIds), ['a', 'b'])
  }
})

test('near-driving threshold is cumulative to the focus, with faster parallel routes retained', () => {
  const graph = buildDependencyGraph([task('a', 0, 10), task('b', 15, 10), task('c', 30, 10)], [dep('a', 'b'), dep('b', 'c')])
  assert.deepEqual(ids(traceDependencyPath(graph, 'c', 'driving', 5).taskIds), ['b', 'c'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'c', 'driving', 10).taskIds), ['a', 'b', 'c'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'a', 'driven', 5).taskIds), ['a', 'b'])
  const shortcut = buildDependencyGraph([...graph.tasks.values()], [...graph.links.map(l => l.dependency), dep('a', 'c', 2, 20)])
  assert.deepEqual(ids(traceDependencyPath(shortcut, 'c', 'driving', 5).taskIds), ['a', 'b', 'c'])
  for (const value of [-1, NaN, Infinity]) assert.equal(traceDependencyPath(graph, 'c', 'driving', value).found, false)
})

test('connecting paths contain all directed branches between endpoints and exclude dead ends', () => {
  const tasks = ['a', 'b', 'c', 'd', 'dead', 'before'].map(id => task(id, 0, 0))
  const graph = buildDependencyGraph(tasks, [dep('a', 'b'), dep('a', 'c'), dep('b', 'd'), dep('c', 'd'), dep('a', 'dead'), dep('before', 'd')])
  const path = traceDependencyPath(graph, 'a', 'connecting', 0, 'd')
  assert.deepEqual(ids(path.taskIds), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(path.dependencyIds), ['a-b', 'a-c', 'b-d', 'c-d'])
  assert.equal(path.found, true)
  assert.equal(traceDependencyPath(graph, 'd', 'connecting', 0, 'a').found, false)
  assert.equal(traceDependencyPath(graph, 'a', 'connecting', 0, 'a').found, false)
  assert.equal(traceDependencyPath(graph, 'a', 'connecting').found, false)
  const extended = buildDependencyGraph([...tasks, task('manual', 0, 0, { auto_schedule: false }), task('cycle', 0, 0)],
    [...graph.links.map(l => l.dependency), dep('d', 'manual'), dep('dead', 'cycle'), dep('cycle', 'dead')])
  assert.deepEqual(traceDependencyPath(extended, 'a', 'connecting', 0, 'd').warnings, [])
  assert.deepEqual(ids(traceDependencyPath(extended, 'a', 'connecting', 0, 'd').taskIds), ['a', 'b', 'c', 'd'])
})

test('inactive ancestors, deleted tasks and disabled links are inspectable but never traversed', () => {
  const tasks = [task('parent', 0, 30, { inactive: true }), task('hidden', 0, 30, { parent_id: 'parent' }),
    task('deleted', 0, 30, { is_deleted: true }), task('off', 0, 30), task('target', 30, 10)]
  const graph = buildDependencyGraph(tasks, [dep('hidden', 'target'), dep('deleted', 'target'), dep('off', 'target', 2, 0, false)])
  assert.deepEqual(graph.links.map(l => l.status), ['inactive', 'missing', 'inactive'])
  assert.equal(graph.incoming.get('target')?.length, 3)
  assert.deepEqual(ids(traceDependencyPath(graph, 'target', 'upstream').taskIds), ['target'])
})

test('manual and fixed successors stop driving propagation while logical tracing remains available', () => {
  const tasks = [task('a', 0, 30), task('manual', 30, 10, { auto_schedule: false }), task('b', 40, 10),
    task('fixed', 50, 10, { constraint_type: 'muststarton', constraint_date: date(50) })]
  const graph = buildDependencyGraph(tasks, [dep('a', 'manual'), dep('manual', 'b'), dep('b', 'fixed')])
  assert.deepEqual(graph.links.map(l => l.status), ['manual', 'driving', 'fixed'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'b', 'driving').taskIds), ['b', 'manual'])
  assert.deepEqual(ids(traceDependencyPath(graph, 'fixed', 'upstream').taskIds), ['a', 'b', 'fixed', 'manual'])
  assert.equal(traceDependencyPath(graph, 'b', 'driving').warnings.length, 1)
})

test('conflicts, impossible dates and aggregate endpoints do not manufacture driving paths', () => {
  const tasks = [task('a', 0, 30), task('b', 20, 10), task('bad', 0, 30, { start_date: '2030-02-30' }),
    task('p', 0, 30), task('child', 0, 30, { parent_id: 'p' }), task('limited', 30, 10, { constraint_type: 'startnoearlierthan', constraint_date: date(60) })]
  const graph = buildDependencyGraph(tasks, [dep('a', 'b'), dep('bad', 'b'), dep('p', 'b'), dep('a', 'limited'), dep('p', 'child')])
  assert.deepEqual(graph.links.map(l => l.status), ['conflict', 'invalid', 'summary', 'conflict', 'invalid'])
  assert.equal(graph.links[0].slackMinutes, -10)
  assert.equal(graph.links[1].slackMinutes, null)
  assert.deepEqual(ids(traceDependencyPath(graph, 'b', 'driving').taskIds), ['b'])
  assert.equal(traceDependencyPath(graph, 'b', 'driving').warnings.length, 3)
})

test('cycles terminate and warn without marking independent zero-slack relationships cyclic', () => {
  const graph = buildDependencyGraph(['a', 'b', 'c', 'x', 'y'].map(id => task(id, 0, 0)), [dep('a', 'b'), dep('b', 'a'), dep('b', 'c'), dep('x', 'y')])
  assert.deepEqual(graph.links.map(l => l.status), ['cycle', 'cycle', 'driving', 'driving'])
  const path = traceDependencyPath(graph, 'c', 'driving')
  assert.deepEqual(ids(path.taskIds), ['b', 'c'])
  assert.ok(path.warnings.some(w => w.includes('循环')))
  assert.deepEqual(ids(traceDependencyPath(graph, 'a', 'downstream').taskIds), ['a', 'b', 'c'])
  assert.deepEqual(traceDependencyPath(graph, 'y', 'driving').warnings, [])
})

test('wall-clock days stay stable across DST and numbering follows hierarchy rather than task codes', () => {
  const tasks = [task('b', 0, 0, { start_date: '2026-03-09T00:00:00', end_date: '2026-03-10T00:00:00', order_index: 2 }),
    task('p', 0, 0, { order_index: 1 }), task('a', 0, 0, { parent_id: 'p', start_date: '2026-03-07T00:00:00', end_date: '2026-03-08T00:00:00' })]
  const graph = buildDependencyGraph(tasks, [dep('a', 'b')])
  assert.deepEqual([...graph.numbers], [['p', 1], ['a', 2], ['b', 3]])
  assert.equal(graph.links[0].slackMinutes, 1440)
  assert.deepEqual(ids(traceDependencyPath(graph, 'b', 'driving', 1440).taskIds), ['a', 'b'])
})

test('long chains and reconvergent graphs are traversed without enumerating paths or recursion', () => {
  const tasks = Array.from({ length: 6000 }, (_, i) => task(String(i), i, 1))
  const graph = buildDependencyGraph(tasks, tasks.slice(1).map((t, i) => dep(String(i), t.id)))
  assert.equal(traceDependencyPath(graph, '5999', 'driving').taskIds.size, 6000)
  assert.equal(traceDependencyPath(graph, '0', 'connecting', 0, '5999').dependencyIds.size, 5999)
})
