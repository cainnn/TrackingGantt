import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Dependency } from '../types'
import { analyzeSchedule, scheduleMinute } from '../lib/scheduleAnalysis'
import { getPlanScheduleIssues, findPlanScheduleConflicts } from '../lib/planScheduleValidation'
import { addMinutesStr } from '../lib/clientTime'

const date = (n: number) => addMinutesStr('2030-01-01T09:00:00', n)!
function task(id: string, start: number, duration: number, extra: Partial<Task> = {}): Task {
  return { id, project_id: 'p', name: id, task_code: id, parent_id: null, assignee: null, start_date: date(start), end_date: date(start + duration),
    duration, duration_unit: 'minute', percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra }
}
const dep = (from: string, to: string, type = 2, lag = 0, active = true): Dependency => ({ id: from + to, project_id: 'p', from_task_id: from, to_task_id: to, type, lag, active })

test('parallel predecessors expose slack and only the driving dependency is critical', () => {
  const tasks = [task('a', 0, 1440), task('b', 0, 2880), task('c', 0, 4320), task('d', 4320, 1440)]
  const deps = [dep('a', 'd'), dep('b', 'd'), dep('c', 'd')]
  const copy = structuredClone({ tasks, deps })
  const analysis = analyzeSchedule(tasks, deps)
  assert.deepEqual([...analysis.tasks.values()].map(t => t.totalSlack), [2880, 1440, 0, 0])
  assert.deepEqual([...analysis.criticalDependencies], ['cd'])
  assert.deepEqual({ tasks, deps }, copy)
  const collapsed = analyzeSchedule([tasks[0], tasks[1], task('d', 2880, 1440)], deps.slice(0, 2))
  assert.equal(collapsed.tasks.get('a')?.totalSlack, 1440)
  assert.deepEqual([...collapsed.criticalDependencies], ['bd'])
})

test('all four dependency types use the appropriate event endpoints with signed minute lag', () => {
  for (const type of [0, 1, 2, 3]) for (const lag of [-15, 20]) {
    const weight = (type & 2 ? 60 : 0) - (type & 1 ? 30 : 0) + lag
    const tasks = [task('a', 100, 60), task('b', 100 + weight, 30)]
    const result = analyzeSchedule(tasks, [dep('a', 'b', type, lag)], date(300))
    assert.equal(result.tasks.get('a')?.totalSlack, Math.min(140, 170 - weight))
    assert.equal(result.tasks.get('b')?.totalSlack, 170 - weight)
    assert.equal(getPlanScheduleIssues(tasks, [dep('a', 'b', type, lag)], { anchorDate: date(100), isMinute: true }).length, 0)
  }
})

test('inactive ancestors and dependencies do not influence horizon or critical chains', () => {
  const tasks = [task('a', 0, 30), task('b', 0, 20), task('parent', 0, 1000, { inactive: true }), task('hidden', 0, 1000, { parent_id: 'parent' })]
  const result = analyzeSchedule(tasks, [dep('a', 'b', 2, 0, false), dep('hidden', 'a')])
  assert.equal(result.tasks.get('a')?.totalSlack, 0)
  assert.equal(result.tasks.get('b')?.totalSlack, 10)
  assert.equal(result.tasks.has('hidden'), false)
  assert.deepEqual(findPlanScheduleConflicts(tasks, [dep('hidden', 'a')]), [])
})

test('manual dates are fixed anchors and incoming scheduling checks remain skipped', () => {
  const tasks = [task('a', 0, 100), task('manual', 10, 30, { auto_schedule: false, constraint_type: 'muststarton', constraint_date: date(500) }), task('b', 40, 20)]
  const deps = [dep('a', 'manual'), dep('manual', 'b')]
  const result = analyzeSchedule(tasks, deps)
  assert.equal(result.tasks.get('manual')?.totalSlack, null)
  assert.equal(result.tasks.get('b')?.totalSlack, 40)
  assert.deepEqual(findPlanScheduleConflicts(tasks, deps), [])
})

test('hard upper limits and deadlines propagate negative slack while deadlines only warn', () => {
  const tasks = [task('a', 0, 30), task('b', 30, 30, { deadline: date(50) })]
  const result = analyzeSchedule(tasks, [dep('a', 'b')])
  assert.equal(result.tasks.get('a')?.totalSlack, -10)
  assert.equal(result.tasks.get('b')?.totalSlack, -10)
  assert.deepEqual(findPlanScheduleConflicts(tasks, [dep('a', 'b')]), [])
  assert.equal(getPlanScheduleIssues(tasks, [dep('a', 'b')])[0].severity, 'warning')
  tasks[1] = { ...tasks[1], deadline: null, constraint_type: 'finishnolaterthan', constraint_date: date(50) }
  assert.equal(findPlanScheduleConflicts(tasks, [dep('a', 'b')]).length, 1)
  assert.equal(analyzeSchedule(tasks, [dep('a', 'b')]).tasks.get('a')?.totalSlack, -10)
})

test('contradictory lower constraints, bad dependencies and cycles never present fictitious slack', () => {
  const a = task('a', 0, 30, { constraint_type: 'startnoearlierthan', constraint_date: date(10) }), b = task('b', 30, 30)
  assert.equal(analyzeSchedule([a, b], [dep('a', 'b')]).tasks.get('b')?.totalSlack, null)
  const issues = getPlanScheduleIssues([task('a', 0, 30), task('b', 20, 30)], [dep('a', 'b')])
  assert.equal(issues[0].taskId, 'b'); assert.equal(issues[0].relatedTaskId, 'a'); assert.equal(issues[0].dependencyId, 'ab')
  const cyclic = analyzeSchedule([a, b, task('ok', 0, 60)], [dep('a', 'b'), dep('b', 'a')])
  assert.equal(cyclic.tasks.get('a')?.totalSlack, null)
  assert.equal(cyclic.tasks.get('ok')?.totalSlack, 0)
  assert.ok(getPlanScheduleIssues([a, b], [dep('a', 'b'), dep('b', 'a')]).some(i => i.kind === 'cycle'))
})

test('summary start dependencies explicitly show unavailable metrics instead of misleading critical paths', () => {
  const tasks = [task('p', 0, 30), task('child', 0, 30, { parent_id: 'p' }), task('b', 30, 30), task('other', 0, 60)]
  const result = analyzeSchedule(tasks, [dep('p', 'b', 0)])
  assert.equal(result.tasks.get('child')?.totalSlack, null)
  assert.equal(result.tasks.get('b')?.totalSlack, null)
  assert.equal(result.tasks.get('other')?.totalSlack, 0)
  assert.equal(result.warnings.length, 1)
})

test('nested summary finish dependencies identify the driving leaf and preserve independent slack', () => {
  const tasks = [task('p', 0, 30), task('nested', 0, 30, { parent_id: 'p' }), task('a', 0, 10, { parent_id: 'nested' }),
    task('b', 0, 30, { parent_id: 'nested' }), task('d', 30, 10)]
  const result = analyzeSchedule(tasks, [dep('p', 'd')])
  assert.equal(result.tasks.get('a')?.totalSlack, 20)
  assert.equal(result.tasks.get('b')?.totalSlack, 0)
  assert.equal(result.tasks.get('d')?.totalSlack, 0)
  assert.deepEqual([...result.criticalDependencies], ['pd'])
  assert.deepEqual(result.warnings, [])
})

test('wall-clock schedule minutes keep calendar days stable across daylight saving boundaries', () => {
  assert.equal(scheduleMinute('2026-03-09T00:00:00')! - scheduleMinute('2026-03-08T00:00:00')!, 1440)
  assert.equal(scheduleMinute('2026-11-02T00:00:00')! - scheduleMinute('2026-11-01T00:00:00')!, 1440)
})
