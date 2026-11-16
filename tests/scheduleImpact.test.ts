import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScheduleImpact } from '../lib/scheduleImpact'
import { planTaskDeletion } from '../lib/taskDeletion'
import { buildBulkEdit } from '../lib/clientBulkEdit'
import { runFullCascade } from '../lib/clientScheduling'
import { addMinutesStr } from '../lib/clientTime'
import type { Task, Dependency } from '../types'
import type { DraftSnapshot } from '../store/draftHistory'

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, parent_id: null, project_id: 'p', task_code: id, name: id.toUpperCase(),
  assignee: null, start_date: '2030-01-01T00:00:00', end_date: '2030-01-02T00:00:00', duration: 1440,
  duration_unit: 'minute', percent_done: 0, auto_schedule: true, constraint_type: 'asap', is_milestone: false,
  note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra })
const dep = (from: string, to: string, extra: Partial<Dependency> = {}): Dependency => ({ id: `${from}-${to}`,
  project_id: 'p', from_task_id: from, to_task_id: to, type: 2, lag: 0, active: true, ...extra })
const snapshot = (tasks: Task[], dependencies: Dependency[] = []): DraftSnapshot => ({ tasks, dependencies, lines: [], statusDate: null, descriptions: {} })
function fixture(minute = false, manual = false) {
  const unit = minute ? 60 : 1440, at = (n: number) => addMinutesStr('2030-01-01T00:00:00', n * unit)!
  const tasks = [['a', 0, 1], ['b', 0, 2], ['c', 0, 3], ['d', 3, 4], ['e', 4, 5]].map(([id, start, end]) => task(String(id), {
    start_date: at(Number(start)), end_date: at(Number(end)), duration: (Number(end) - Number(start)) * unit, auto_schedule: id === 'd' ? !manual : true,
  }))
  return { before: snapshot(tasks, [dep('a', 'd'), dep('b', 'd'), dep('c', 'd'), dep('d', 'e')]), at, unit }
}
const remove = (before: DraftSnapshot, ids: string[], isMinute = false) => {
  const result = planTaskDeletion(before.tasks, before.dependencies, ids, { deletionDate: '2026-11-01T00:00:00', operationId: '12345678-1234-4321-8123-123456789012', isMinute })
  return { ...before, tasks: result.tasks, dependencies: result.dependencies }
}
for (const minute of [false, true]) test(`delete preview identifies C, D and E with actual binding predecessor (${minute ? 'minute' : 'day'})`, () => {
  const { before, unit } = fixture(minute), frozen = JSON.stringify(before)
  const after = remove(before, ['c'], minute)
  const impact = buildScheduleImpact(before, after, { label: '删除任务', directTaskIds: ['c'] })
  assert.deepEqual(impact.tasks.map(t => t.id), ['c', 'd', 'e'])
  assert.equal(impact.tasks[0].kind, 'deleted')
  for (const row of impact.tasks.slice(1)) {
    assert.equal(row.category, 'cascade'); assert.equal(row.startDelta, -unit); assert.equal(row.finishDelta, -unit); assert.equal(row.durationDelta, 0)
  }
  assert.match(impact.tasks[1].reason, /删除前置「C」/)
  assert.match(impact.tasks[1].reason, /当前由「B」（FS）约束/)
  assert.match(impact.tasks[2].reason, /随前置「D」（FS）调整/)
  assert.deepEqual(impact.tasks[2].relatedIds, ['d'])
  assert.equal(impact.dependencies[0].after, undefined)
  assert.equal(JSON.stringify(before), frozen, 'analysis never mutates a draft')
})
test('manual target keeps dates, explains removed relation and stops its downstream chain', () => {
  const { before } = fixture(false, true)
  const impact = buildScheduleImpact(before, remove(before, ['c']), { label: '删除任务' })
  const d = impact.tasks.find(t => t.id === 'd')!
  assert.equal(d.category, 'manual'); assert.equal(d.startDelta, 0)
  assert.match(d.reason, /手动排程.*保持不变/)
  assert.ok(!impact.tasks.some(t => t.id === 'e'))
})
test('bulk move tags direct selection and distinguishes real downstream cascade', () => {
  const { before, unit } = fixture()
  const updates = new Map(buildBulkEdit(before.tasks, before.dependencies, ['d'], { shiftMinutes: unit }, false, '2030-01-01').map(t => [t.id, t]))
  const after = { ...before, tasks: before.tasks.map(t => updates.get(t.id) ?? t) }
  const impact = buildScheduleImpact(before, after, { label: '移动任务', directTaskIds: ['d'] })
  assert.equal(impact.tasks.find(t => t.id === 'd')?.category, 'direct')
  assert.match(impact.tasks.find(t => t.id === 'd')!.reason, /当前为手动排程/)
  assert.equal(impact.tasks.find(t => t.id === 'e')?.category, 'cascade')
  assert.equal(impact.tasks.find(t => t.id === 'e')?.finishDelta, unit)
})
for (const type of [0, 1, 2, 3]) test(`dependency type ${type} names tight bounds with negative minute lag`, () => {
  const before = snapshot([task('a'), task('b')])
  const dependencies = [dep('a', 'b', { type, lag: -15 })]
  const updates = new Map(runFullCascade(before.tasks, dependencies, { isMinute: true }).map(t => [t.id, t]))
  const after = { ...before, dependencies, tasks: before.tasks.map(t => updates.get(t.id) ?? t) }
  const row = buildScheduleImpact(before, after, { label: '修改任务依赖' }).tasks.find(t => t.id === 'b')!
  assert.equal(row.category, 'direct'); assert.deepEqual(row.relatedIds, ['a'])
  assert.match(row.reason, /当前由「A」/)
})
test('inactive links and unrelated side changes are not presented as automatic cascades', () => {
  const before = snapshot([task('a'), task('b'), task('c')], [dep('a', 'b', { active: false })])
  const after = { ...before, tasks: before.tasks.map(t => ({ ...t, start_date: '2030-01-02', end_date: '2030-01-03' })) }
  const impact = buildScheduleImpact(before, after, { label: '修改任务', directTaskIds: ['a'] })
  assert.equal(impact.tasks.find(t => t.id === 'b')?.category, 'other')
  assert.equal(impact.tasks.find(t => t.id === 'c')?.category, 'other')
  assert.deepEqual(impact.tasks.find(t => t.id === 'b')?.relatedIds, [])
})
test('summary rollup is distinct from edited child and downstream dependency', () => {
  const before = snapshot([task('parent'), task('a', { parent_id: 'parent' }), task('b')], [dep('parent', 'b')])
  const after = { ...before, tasks: before.tasks.map(t => ({ ...t, start_date: '2030-01-03', end_date: '2030-01-04' })) }
  const impact = buildScheduleImpact(before, after, { label: '移动子任务', directTaskIds: ['a'] })
  assert.equal(impact.tasks.find(t => t.id === 'parent')?.category, 'summary')
  assert.equal(impact.tasks.find(t => t.id === 'b')?.category, 'cascade')
})
test('relationship-only and project-only changes are visible even without a date shift', () => {
  const before = snapshot([task('a'), task('b')], [dep('a', 'b')])
  const after = { ...before, statusDate: '2030-01-02', dependencies: [dep('a', 'b', { active: false })] }
  const impact = buildScheduleImpact(before, after, { label: '停用依赖' })
  assert.deepEqual(impact.projectChanges, ['状态日期'])
  assert.deepEqual(impact.tasks[0].fields, ['前置依赖']); assert.equal(impact.tasks[0].startDelta, 0)
  assert.equal(impact.dependencies[0].after?.active, false)
})
test('latest compares one event, cumulative compares saved draft and omits canceled changes', () => {
  const before = snapshot([task('a')]), first = snapshot([task('a', { name: 'Edit' })])
  const latest = buildScheduleImpact(first, before, { label: '改回名称', directTaskIds: ['a'] })
  assert.equal(latest.tasks.length, 1)
  assert.equal(buildScheduleImpact(before, before, { label: '累计', cumulative: true, directTaskIds: ['a'] }).tasks.length, 0)
})
test('missing dates remain unknown and day deltas across DST remain calendar days', () => {
  const before = snapshot([task('a', { start_date: null, end_date: null }), task('b', { start_date: '2026-03-07', end_date: '2026-03-08' })])
  const after = snapshot([task('a'), task('b', { start_date: '2026-03-08', end_date: '2026-03-09' })])
  const result = buildScheduleImpact(before, after, { label: '日期修改', directTaskIds: ['a', 'b'] })
  assert.equal(result.tasks[0].startDelta, null); assert.equal(result.tasks[1].startDelta, 1440); assert.equal(result.tasks[1].finishDelta, 1440)
})
test('large impact list supports a 10000 task chain without recursive traversal', () => {
  const tasks = Array.from({ length: 10000 }, (_, n) => task(String(n)))
  const dependencies = tasks.slice(1).map((t, n) => dep(String(n), t.id))
  const before = snapshot(tasks, dependencies), after = snapshot(tasks.map(t => ({ ...t, start_date: '2030-01-02', end_date: '2030-01-03' })), dependencies)
  const result = buildScheduleImpact(before, after, { label: '移动任务', directTaskIds: ['0'] })
  assert.equal(result.tasks.length, 10000); assert.equal(result.tasks.at(-1)?.category, 'cascade')
})

test('last predecessor deletion explains the existing manual reanchor rule and its automatic downstream impact', () => {
  const { before } = fixture(false, true)
  before.dependencies = [dep('c', 'd'), dep('d', 'e')]
  const after = remove(before, ['c'])
  const result = buildScheduleImpact(before, after, { label: '删除任务', directTaskIds: ['c'] })
  const d = result.tasks.find(t => t.id === 'd')!
  assert.equal(d.category, 'other')
  assert.match(d.reason, /删除最后一个有效前置.*重设日期.*仍为手动排程/)
  assert.notEqual(d.startDelta, 0)
  assert.equal(result.tasks.find(t => t.id === 'e')?.category, 'cascade')
  assert.match(result.tasks.find(t => t.id === 'e')!.reason, /随前置「D」/)
})

test('parent-only deletion explains promotion while showing the child as retained', () => {
  const before = snapshot([task('parent'), task('child', { parent_id: 'parent', auto_schedule: false })])
  const result = planTaskDeletion(before.tasks, [], ['parent'], { includeDescendants: false })
  const impact = buildScheduleImpact(before, { ...before, tasks: result.tasks }, { label: '仅删除父任务', directTaskIds: ['parent'] })
  const child = impact.tasks.find(t => t.id === 'child')!
  assert.equal(child.kind, 'changed'); assert.ok(child.after)
  assert.match(child.reason, /删除父任务后保留.*提升至顶层/)
  assert.ok(child.fields.includes('层级'))
})
