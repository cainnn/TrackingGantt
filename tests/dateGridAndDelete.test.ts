import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Task, Dependency } from '../types'
import { parseDateInput, formatDateDisplay } from '../lib/clientDateInput'
import { applyGridPaste, gridSelectionRect } from '../lib/clientGridEdit'
import { taskBranchIds } from '../lib/taskTree'
import { buildSaveDiff } from '../lib/clientSave'
import { createDraftMiddleware, rootReducer, initializeDraft, labelDraftStep, snapshotDraft, undoDraft, redoDraft } from '../store/draftHistory'
import { deleteTasks, setTasks } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'

const task = (id: string, parent_id: string | null = null): Task => ({ id, parent_id, project_id: 'p', task_code: id, name: id, assignee: null,
  start_date: '2026-11-01T00:00:00', end_date: '2026-11-02T00:00:00', duration: 1440, duration_unit: 'day',
  percent_done: 0, auto_schedule: true, constraint_type: 'asap', is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '' })

test('year-first typed and Excel dates normalize without depending on browser locale', () => {
  for (const value of ['2026-11-04', '2026/11/4', '2026年11月4日', '20261104', "'2026/11/04", '26-11-4', '２６/１１/４']) {
    assert.equal(parseDateInput(value, false, 2026), '2026-11-04', value)
  }
  assert.equal(parseDateInput('2026/11/4 9:05:20', true), '2026-11-04T09:05')
  assert.equal(parseDateInput('20260808'), '2026-08-08')
  assert.equal(formatDateDisplay('2026-11-04T09:05:00'), '26-11-04')
  assert.equal(formatDateDisplay('2026-11-04T09:05:00', true), '26-11-04 09:05')
  assert.equal(parseDateInput('99-12-31', false, 1999), '1999-12-31')
  assert.equal(parseDateInput('00-01-01', false, 1999), '2000-01-01')
})

test('Excel date serials preserve day/minute precision and reject its fictitious leap day', () => {
  assert.equal(parseDateInput('46023'), '2026-01-01')
  assert.equal(parseDateInput('46330.5', true), '2026-11-04T12:00')
  assert.equal(parseDateInput('1'), '1900-01-01')
  assert.equal(parseDateInput('60'), null)
  for (const input of ['2026/2/29', '2026-13-01', '26-11-31', '2026/11/04 24:00', '2026/11/04 9:60', '11/04/2026', '2958466']) assert.equal(parseDateInput(input), null, input)
  assert.equal(parseDateInput('2028年2月29日'), '2028-02-29')
})

test('two-row Excel date paste pins explicit dates, retains dependencies and computes durations once per row', () => {
  const tasks = [task('a'), task('b')]
  const dependencies: Dependency[] = [{ id: 'd', project_id: 'p', from_task_id: 'a', to_task_id: 'b', type: 2, lag: 0 }]
  const original = structuredClone({ tasks, dependencies })
  const result = applyGridPaste(tasks, dependencies, ['a', 'b'], ['start', 'end'], { taskId: 'a', col: 'start' }, '2026/11/4\t26-11-08\r\n2026年11月5日\t46337\r\n', false)
  assert.deepEqual(result.tasks.map(t => [t.start_date, t.end_date, t.duration, t.auto_schedule]), [
    ['2026-11-04T00:00:00', '2026-11-08T00:00:00', 5760, false],
    ['2026-11-05T00:00:00', '2026-11-11T00:00:00', 8640, false],
  ])
  assert.deepEqual(result.dependencies, dependencies)
  assert.deepEqual({ tasks, dependencies }, original)
  assert.deepEqual(buildSaveDiff(tasks, dependencies, result.tasks, result.dependencies).tasksToUpdate.map(t => t.id), ['a', 'b'])
})

test('unchanged date paste keeps automatic scheduling and invalid batches cannot partially overwrite tasks', () => {
  const tasks = [task('a'), task('b')], before = structuredClone(tasks)
  const same = applyGridPaste(tasks, [], ['a', 'b'], ['start', 'end'], { taskId: 'a', col: 'start' }, '26/11/1\t2026/11/2', false)
  assert.deepEqual(same.tasks, tasks)
  const compact = applyGridPaste(tasks, [], ['a', 'b'], ['start', 'end'], { taskId: 'a', col: 'start' }, '20260808\t20260810\n20260809\t20260812', false)
  assert.equal(compact.tasks[0].start_date, '2026-08-08T00:00:00')
  assert.equal(compact.tasks[1].end_date, '2026-08-12T00:00:00')
  assert.throws(() => applyGridPaste(tasks, [], ['a', 'b'], ['start', 'end'], { taskId: 'a', col: 'start' }, '26/11/4\t26/11/8\n26/2/30\t26/3/1', false), /第 2 行、第 1 列.*日期无效/)
  assert.throws(() => applyGridPaste([task('parent'), task('child', 'parent')], [], ['parent', 'child'], ['start'], { taskId: 'parent', col: 'start' }, '26/11/4', false), /只读/)
  assert.deepEqual(tasks, before)
})

test('minute date paste keeps time-of-day and exact stored minute duration', () => {
  const result = applyGridPaste([task('a')], [], ['a'], ['start', 'end'], { taskId: 'a', col: 'start' }, '26/11/4 09:15\t2026-11-04 10:45', true)
  assert.equal(result.tasks[0].duration, 90)
  assert.equal(result.tasks[0].start_date, '2026-11-04T09:15:00')
  assert.equal(result.tasks[0].end_date, '2026-11-04T10:45:00')
})

test('rectangular selection uses visible order, fills single values and accepts differently sized clipboard data', () => {
  const tasks = [task('a'), task('b'), task('hidden')]
  const rows = ['b', 'a'], columns = ['end', 'duration', 'start']
  assert.deepEqual(gridSelectionRect(rows, columns, { taskId: 'a', col: 'start' }, { taskId: 'b', col: 'duration' }), { top: 0, bottom: 1, left: 1, right: 2 })
  const result = applyGridPaste(tasks, [], rows, columns, { taskId: 'a', col: 'duration' }, '5天', false, { taskId: 'b', col: 'duration' })
  assert.deepEqual(result.tasks.map(t => t.duration), [7200, 7200, 1440])
  assert.equal(result.selection.start.taskId, 'b')
  assert.equal(result.selection.end.taskId, 'a')
  assert.equal(result.tasks[0].end_date?.slice(0, 10), '2026-11-06')
  const expanded = applyGridPaste(tasks, [], ['a', 'b', 'hidden'], ['duration'], { taskId: 'a', col: 'duration' }, '1\n2\n3', false, { taskId: 'b', col: 'duration' })
  assert.deepEqual(expanded.tasks.map(t => t.duration), [1440, 2880, 4320])
  assert.equal(expanded.selection.end.taskId, 'hidden')
  const smaller = applyGridPaste(tasks, [], ['a', 'b', 'hidden'], ['duration', 'start', 'end'], { taskId: 'a', col: 'duration' }, '2\t20261101', false, { taskId: 'b', col: 'end' })
  assert.deepEqual(smaller.tasks.map(t => t.duration), [2880, 1440, 1440])
  assert.deepEqual(smaller.selection.end, { taskId: 'a', col: 'start' })
  assert.deepEqual(tasks.map(t => t.duration), [1440, 1440, 1440])
})

test('selected minute/time regions preserve each task date and accept duration units', () => {
  const tasks = [{ ...task('a'), start_date: '2026-11-01T08:00:00', end_date: '2026-11-01T09:00:00', duration: 60 },
    { ...task('b'), start_date: '2026-11-02T08:00:00', end_date: '2026-11-02T09:00:00', duration: 60 }]
  const result = applyGridPaste(tasks, [], ['a', 'b'], ['start', 'end'], { taskId: 'a', col: 'start' }, '09:15\t10:45', true, { taskId: 'b', col: 'end' })
  assert.deepEqual(result.tasks.map(t => [t.start_date, t.end_date, t.duration]), [
    ['2026-11-01T09:15:00', '2026-11-01T10:45:00', 90], ['2026-11-02T09:15:00', '2026-11-02T10:45:00', 90],
  ])
  const durations = applyGridPaste(tasks, [], ['a', 'b'], ['duration'], { taskId: 'a', col: 'duration' }, '1.5小时\n45分钟', true, { taskId: 'b', col: 'duration' })
  assert.deepEqual(durations.tasks.map(t => t.duration), [90, 45])
  assert.equal(parseDateInput('9:30', true, 2026, '2026-11-04'), '2026-11-04T09:30')
  assert.equal(parseDateInput('25:30', true, 2026, '2026-11-04'), null)
})

test('deleting a selected parent removes every descendant and their links as one undoable step', async () => {
  const tasks = [task('p'), task('c', 'p'), task('g', 'c'), task('kept'), task('moved-out')]
  const dependencies: Dependency[] = [
    { id: 'internal', project_id: 'p', from_task_id: 'c', to_task_id: 'g', type: 2, lag: 0 },
    { id: 'external', project_id: 'p', from_task_id: 'g', to_task_id: 'kept', type: 2, lag: 0 },
    { id: 'keep', project_id: 'p', from_task_id: 'moved-out', to_task_id: 'kept', type: 2, lag: 0 },
  ]
  assert.deepEqual([...taskBranchIds(tasks, ['p', 'c', 'missing'])], ['p', 'c', 'g'])
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: null, planning_status: 'draft', created_at: '' }))
  store.dispatch(setTasks({ tasks, dependencies }))
  const baseline = snapshotDraft(store.getState()); store.dispatch(initializeDraft({ projectId: 'p', baseline }))
  store.dispatch(labelDraftStep('删除任务及子任务')); store.dispatch(deleteTasks(['p']))
  await Promise.resolve()
  assert.deepEqual(store.getState().tasks.tasks.map(t => t.id), ['kept', 'moved-out'])
  assert.deepEqual(store.getState().tasks.dependencies.map(d => d.id), ['keep'])
  assert.deepEqual(buildSaveDiff(tasks, dependencies, store.getState().tasks.tasks, store.getState().tasks.dependencies).tasksToDelete.sort(), ['c', 'g', 'p'])
  assert.equal(store.getState().draft.past.length, 1)
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), baseline)
  store.dispatch(redoDraft()); assert.deepEqual(store.getState().tasks.tasks.map(t => t.id), ['kept', 'moved-out'])
})
