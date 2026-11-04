import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, undoDraft, redoDraft, beginDraftSave, finishDraftSave, failDraftSave, resetDraft, hasDraftChanges } from '../store/draftHistory'
import { setCurrentProject, setStatusDate } from '../store/slices/projectSlice'
import { setTasks, updateTasks, addDependency, setSelectedIds, clearTasks, deleteTasks, setViewSnapshot, clearViewSnapshot } from '../store/slices/tasksSlice'
import { addProjectLine } from '../store/slices/projectLinesSlice'
import type { Task } from '../types'

const task: Task = {
  id: 'a', project_id: 'p', parent_id: null, task_code: '1', name: 'A', assignee: null,
  start_date: '2026-11-01T00:00:00', end_date: '2026-11-02T00:00:00', duration: 1440,
  duration_unit: 'minute', percent_done: 0, is_milestone: false, note: null,
  order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '',
}
function setup() {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: '2026-11-01T00:00:00', created_at: '' }))
  store.dispatch(setTasks({ tasks: [task, { ...task, id: 'b', task_code: '2', name: 'B' }], dependencies: [] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  return store
}
test('one user operation undoes task edits, dependency changes and cascades together; selection has no history', async () => {
  const store = setup()
  const base = snapshotDraft(store.getState())
  store.dispatch(setSelectedIds(['a']))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length, 0)
  store.dispatch(updateTasks([{ ...task, name: 'Edited' }]))
  store.dispatch(addDependency({ id: 'd', project_id: 'p', from_task_id: 'a', to_task_id: 'b', type: 2, lag: 0 }))
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[1], start_date: '2026-11-02T00:00:00' }]))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length, 1)
  const edited = snapshotDraft(store.getState())
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), base)
  assert.equal(hasDraftChanges(store.getState()), false)
  store.dispatch(redoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), edited)
  store.dispatch(undoDraft())
  store.dispatch(updateTasks([{ ...task, name: 'Different' }]))
  await Promise.resolve()
  assert.equal(store.getState().draft.future.length, 0)
})
test('project lines and status date are drafts and can be undone or discarded without persistence', async () => {
  const store = setup(), base = snapshotDraft(store.getState())
  store.dispatch(addProjectLine({ id: 'l', project_id: 'p', name: '节点', line_date: '2026-11-06', color: '#fff', visible: true }))
  store.dispatch(setStatusDate({ projectId: 'p', statusDate: '2026-11-05' }))
  await Promise.resolve()
  assert.equal(hasDraftChanges(store.getState()), true)
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), base)
  store.dispatch(redoDraft())
  store.dispatch(resetDraft(base))
  assert.deepEqual(snapshotDraft(store.getState()), base)
  assert.equal(store.getState().draft.past.length, 0)
})
test('successful save creates an undo boundary and rebases every later step on server values', async () => {
  const store = setup()
  store.dispatch(updateTasks([{ ...task, name: 'Submitted' }]))
  store.dispatch(beginDraftSave()) // synchronously flush before submission
  const submitted = snapshotDraft(store.getState())
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[0], name: 'During 1' }]))
  await Promise.resolve()
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[0], assignee: '张三' }]))
  await Promise.resolve()
  const server = { ...submitted, tasks: submitted.tasks.map(t => ({ ...t, percent_done: 90 })) }
  store.dispatch(finishDraftSave(server))
  assert.equal(store.getState().draft.past.length, 2)
  assert.equal(store.getState().tasks.tasks[0].percent_done, 90)
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].assignee, null)
  assert.equal(store.getState().tasks.tasks[0].name, 'During 1')
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].name, 'Submitted')
  assert.equal(hasDraftChanges(store.getState()), false)
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].name, 'Submitted')
})
test('uncertain saves block undo until retry or reconciliation establishes the saved boundary', async () => {
  const store = setup()
  store.dispatch(updateTasks([{ ...task, name: 'Submitted' }]))
  store.dispatch(beginDraftSave())
  store.dispatch(failDraftSave())
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].name, 'Submitted')
  store.dispatch(deleteTasks(['a']))
  await Promise.resolve()
  store.dispatch(beginDraftSave())
  const saved = snapshotDraft(store.getState())
  store.dispatch(finishDraftSave(saved))
  assert.equal(store.getState().draft.uncertain, false)
  assert.equal(store.getState().draft.past.length, 0)
  assert.equal(store.getState().tasks.tasks.some(t => t.id === 'a'), false)
})
test('history is isolated from historical viewing and cleared when switching projects', async () => {
  const store = setup()
  store.dispatch(setViewSnapshot({ tasks: [], dependencies: [], versionId: 'v', versionName: 'V' }))
  store.dispatch(updateTasks([{ ...task, name: 'Blocked' }]))
  await Promise.resolve()
  assert.equal(store.getState().tasks.tasks[0].name, 'A')
  store.dispatch(clearViewSnapshot())
  store.dispatch(updateTasks([{ ...task, name: 'Allowed' }]))
  await Promise.resolve()
  store.dispatch(clearTasks())
  assert.equal(store.getState().draft.past.length, 0)
  assert.equal(store.getState().draft.baseline, null)
})
