import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Dependency } from '../types'
import type { SaveBaseline } from '../lib/clientSave'
import { findPlanSaveConflicts, findPlanSaveMismatches } from '../lib/planSaveVerification'
import { findPlanScheduleConflicts } from '../lib/planScheduleValidation'
import { planTaskDeletion } from '../lib/taskDeletion'
import { addMinutesStr } from '../lib/clientTime'

function task(id: string, start = 0, duration = 1, extra: Partial<Task> = {}): Task {
  const at = (offset: number) => addMinutesStr('2030-01-01T00:00:00', offset * 1440)!
  return { id, project_id: 'p', parent_id: null, task_code: id, name: id.toUpperCase(), assignee: null,
    start_date: at(start), end_date: at(start + duration), duration: duration * 1440, duration_unit: 'day',
    percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false,
    deleted_at: null, created_at: '', updated_at: '', ...extra }
}
const dep = (from: string, to: string, type = 2, lag = 0): Dependency => ({ id: `${from}-${to}`, project_id: 'p', from_task_id: from, to_task_id: to, type, lag })
const state = (tasks: Task[], dependencies: Dependency[] = []): SaveBaseline => ({ tasks, dependencies, statusDate: null, planningStatus: 'draft', lines: [], customFields: [] })
function deletion() {
  const before = state([task('a'), task('b', 0, 2), task('c', 0, 3), task('d', 3), task('e', 4), task('f', 5), task('g', 6)],
    [dep('a', 'd'), dep('b', 'd'), dep('c', 'd'), dep('d', 'e'), dep('e', 'f'), dep('f', 'g')])
  const result = planTaskDeletion(before.tasks, before.dependencies, ['c'], { deletionDate: '2029-01-01' })
  return { before, after: state(result.tasks, result.dependencies) }
}

test('a deleted longest predecessor and all four shifted successors must match database readback', () => {
  const { before, after } = deletion()
  assert.deepEqual(findPlanSaveConflicts(before, before, after), [])
  assert.deepEqual(findPlanSaveMismatches(after, structuredClone(after)), [])
  assert.deepEqual(findPlanScheduleConflicts(after.tasks, after.dependencies), [])
  const stale = { ...after, tasks: after.tasks.map(t => ['d', 'e', 'f', 'g'].includes(t.id) ? before.tasks.find(old => old.id === t.id)! : t) }
  const issues = findPlanSaveMismatches(after, stale)
  for (const id of ['D', 'E', 'F', 'G']) assert.ok(issues.some(issue => issue.includes(`「${id}」`)))
  assert.ok(findPlanSaveMismatches(after, before).some(issue => issue.includes('「C」')))
})

test('missing dependencies, undeleted records and project metadata cannot be reported as saved', () => {
  const { after } = deletion()
  const missing = { ...after, dependencies: after.dependencies.slice(1), statusDate: '2030-02-01',
    planningStatus: 'stable' as const, lines: [{ id: 'line', project_id: 'p', name: '新增项目线', line_date: '2030-01-02', color: '#ff0000', visible: true }] }
  const issues = findPlanSaveMismatches(after, missing)
  for (const label of ['依赖', '状态日期', '计划状态', '项目线']) assert.ok(issues.some(issue => issue.includes(label)))
})

test('database date formatting, object key order and implicit task defaults do not cause false mismatches', () => {
  const before = state([task('a')], [dep('a', 'a', 0)])
  const saved = state([{ ...before.tasks[0], start_date: '2030-01-01 00:00:00', auto_schedule: true,
    constraint_type: 'asap', rollup: false, inactive: false, project_boundary: 'ask', custom_fields: [], custom_values: {}, updated_at: 'later' }],
  [{ ...before.dependencies[0], active: true }])
  assert.deepEqual(findPlanSaveMismatches(before, saved), [])
})

test('a stale deletion cannot silently overwrite another editor changing a successor', () => {
  const { before, after } = deletion()
  const remote = { ...before, tasks: before.tasks.map(t => t.id === 'd' ? { ...t, name: '他人刚修改的任务' } : t) }
  assert.ok(findPlanSaveConflicts(before, remote, after).some(issue => issue.includes('他人刚修改')))
})

test('remote additions, deletions and new predecessor links require review before writing', () => {
  const { before, after } = deletion()
  assert.ok(findPlanSaveConflicts(before, { ...before, tasks: [...before.tasks, task('remote')] }, after).length)
  assert.ok(findPlanSaveConflicts(before, { ...before, tasks: before.tasks.filter(t => t.id !== 'd') }, after).some(issue => issue.includes('已被其他操作删除')))
  assert.ok(findPlanSaveConflicts(before, { ...before, dependencies: [...before.dependencies, dep('a', 'g')] }, after).some(issue => issue.includes('依赖')))
})

test('identical remote results and a previously committed failed attempt can be retried', () => {
  const { before, after } = deletion()
  assert.deepEqual(findPlanSaveConflicts(before, after, after), [])
  const editedAfterFailure = { ...after, tasks: after.tasks.map(t => t.id === 'd' ? { ...t, name: '失败后继续修改' } : t) }
  assert.deepEqual(findPlanSaveConflicts(before, after, editedAfterFailure, [after]), [])
  const created = state([...after.tasks, task('new')], after.dependencies)
  assert.deepEqual(findPlanSaveConflicts(before, created, { ...created, tasks: created.tasks.map(t => t.id === 'new' ? { ...t, name: '重试前新名称' } : t) }, [created]), [])
  const unexpected = { ...after, tasks: after.tasks.map(t => t.id === 'd' ? { ...t, note: '别人后续修改' } : t) }
  assert.ok(findPlanSaveConflicts(before, unexpected, editedAfterFailure, [after]).length)
})

test('a task modified remotely cannot be deleted using an unchanged old copy', () => {
  const { before, after } = deletion()
  const remote = { ...before, tasks: before.tasks.map(t => t.id === 'c' ? { ...t, note: '删除前被修改' } : t) }
  assert.ok(findPlanSaveConflicts(before, remote, after).some(issue => issue.includes('「C」')))
})

test('schedule validation covers all four dependency types and signed minute lags', () => {
  const a = task('a', 0, 2), b = task('b', 2)
  for (const type of [0, 1, 2, 3]) {
    assert.deepEqual(findPlanScheduleConflicts([a, b], [dep('a', 'b', type)]), [])
    const invalid = task('b', -5)
    assert.ok(findPlanScheduleConflicts([a, invalid], [dep('a', 'b', type, -30)]).length)
  }
  const minute = { ...b, start_date: '2030-01-03T00:15:00', end_date: '2030-01-04T00:15:00' }
  assert.deepEqual(findPlanScheduleConflicts([a, minute], [dep('a', 'b', 2, 15)]), [])
  assert.ok(findPlanScheduleConflicts([a, minute], [dep('a', 'b', 2, 16)]).length)
})

test('schedule validation respects manual mode and inherited inactivity while detecting hard date conflicts', () => {
  const a = task('a', 0, 3), b = task('b', 0)
  assert.ok(findPlanScheduleConflicts([a, b], [dep('a', 'b')]).length)
  assert.deepEqual(findPlanScheduleConflicts([a, { ...b, auto_schedule: false }], [dep('a', 'b')]), [])
  assert.deepEqual(findPlanScheduleConflicts([a, task('parent', 0, 1, { inactive: true }), { ...b, parent_id: 'parent' }], [dep('a', 'b')]), [])
  assert.ok(findPlanScheduleConflicts([{ ...b, constraint_type: 'muststarton', constraint_date: '2030-01-02' }], []).length)
  assert.ok(findPlanScheduleConflicts([{ ...b, constraint_type: 'finishnolaterthan', constraint_date: '2030-01-01' }], []).length)
})
