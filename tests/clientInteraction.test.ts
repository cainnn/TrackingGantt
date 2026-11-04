import test from 'node:test'
import assert from 'node:assert/strict'
import { applyGridPaste, parseClipboardGrid } from '../lib/clientGridEdit'
import { buildBulkEdit } from '../lib/clientBulkEdit'
import { buildTaskCopies } from '../lib/clientTaskCopy'
import type { Task } from '../types'

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, project_id: 'p', parent_id: null, task_code: id, name: id, assignee: null,
    start_date: '2026-11-01T00:00:00', end_date: '2026-11-02T00:00:00', duration: 1440,
    duration_unit: 'minute', percent_done: 0, is_milestone: false, note: null,
    order_index: Number(id), is_deleted: false, deleted_at: null, created_at: '', updated_at: '', auto_schedule: false, ...extra }
}
test('clipboard parser preserves quoted tabs, multiline names and empty cells', () => {
  assert.deepEqual(parseClipboardGrid('"A\tB"\t张三\r\n"line1\nline2"\t\r\n'), [['A\tB', '张三'], ['line1\nline2', '']])
})
test('range paste follows visible row and column order, cascades once and is atomic on invalid data', () => {
  const tasks = [task('1'), task('2'), task('3')]
  const before = structuredClone(tasks)
  const result = applyGridPaste(tasks, [], ['3', '1'], ['name', 'assignee', 'duration'], { taskId: '3', col: 'name' }, '三\t张三\t2\n一\t李四\t3', false)
  assert.equal(result.tasks[2].name, '三')
  assert.equal(result.tasks[2].duration, 2880)
  assert.equal(result.tasks[0].duration, 4320)
  assert.equal(result.tasks[1].name, '2')
  assert.throws(() => applyGridPaste(tasks, [], ['1', '2'], ['name', 'duration'], { taskId: '1', col: 'name' }, 'New\t2\nOther\tbad', false), /正整数/)
  assert.deepEqual(tasks, before)
})
test('range paste rejects derived fields, invalid date spans, summaries and out of bounds', () => {
  const tasks = [task('1'), task('2', { parent_id: '1' })]
  assert.throws(() => applyGridPaste(tasks, [], ['1', '2'], ['duration'], { taskId: '1', col: 'duration' }, '3', false), /只读/)
  assert.throws(() => applyGridPaste(tasks, [], ['2'], ['end'], { taskId: '2', col: 'end' }, '2026-10-30', false), /结束时间/)
  assert.throws(() => applyGridPaste(tasks, [], ['2'], ['end'], { taskId: '2', col: 'end' }, '2026-02-31', false), /日期无效/)
  assert.throws(() => applyGridPaste(tasks, [], ['2'], ['name'], { taskId: '2', col: 'name' }, 'a\tb', false), /超出/)
})
test('minute paste preserves minutes while day paste stores full-day durations', () => {
  for (const isMinute of [true, false]) {
    const result = applyGridPaste([task('1')], [], ['1'], ['duration'], { taskId: '1', col: 'duration' }, '45', isMinute)
    assert.equal(result.tasks[0].duration, isMinute ? 45 : 64800)
  }
})
test('bulk move includes descendants once, pins moved leaves and preserves other manual tasks', () => {
  const tasks = [task('1'), task('2', { parent_id: '1', auto_schedule: true }), task('3')]
  const updates = buildBulkEdit(tasks, [], ['1', '2'], { shiftMinutes: 1440, assignee: '张三' }, false, '2026-11-01T00:00:00')
  assert.equal(updates.find(t => t.id === '2')?.start_date, '2026-11-02T00:00:00')
  assert.equal(updates.find(t => t.id === '2')?.auto_schedule, false)
  assert.equal(updates.find(t => t.id === '1')?.end_date, '2026-11-03T00:00:00')
  assert.equal(updates.some(t => t.id === '3'), false)
  assert.equal(updates.filter(t => t.id === '2').length, 1)
})
test('clipboard paste uses its captured subtree even if originals are removed or changed', () => {
  const source = [task('1'), task('2', { parent_id: '1' })]
  const result = buildTaskCopies([task('3')], [], ['1'], '3', 'after', { tasks: source, dependencies: [] })
  assert.equal(result.tasksToAdd.length, 2)
  assert.equal(result.tasksToAdd[1].parent_id, result.tasksToAdd[0].id)
  assert.deepEqual(result.tasksToAdd.map(t => t.task_code), ['4', '5'])
  const empty = buildTaskCopies([], [], ['1'], null, 'after', { tasks: source, dependencies: [] })
  assert.equal(empty.tasksToAdd.length, 2)
})
