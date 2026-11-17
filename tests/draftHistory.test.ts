import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer, createDraftMiddleware, labelDraftStep, initializeDraft, snapshotDraft, undoDraft, redoDraft, beginDraftSave, finishDraftSave, failDraftSave, resetDraft, hasDraftChanges } from '../store/draftHistory'
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

test('hierarchy edits made during save remain local and undo back to the saved hierarchy', async () => {
  const store = setup()
  const b = store.getState().tasks.tasks[1]
  store.dispatch(updateTasks([{ ...b, parent_id: 'a' }]))
  store.dispatch(beginDraftSave())
  const saved = snapshotDraft(store.getState())
  store.dispatch(updateTasks([{ ...b, parent_id: null, order_index: 2 }]))
  await Promise.resolve()
  store.dispatch(finishDraftSave(saved))
  assert.equal(store.getState().tasks.tasks[1].parent_id, null)
  assert.equal(hasDraftChanges(store.getState()), true)
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[1].parent_id, 'a')
  assert.equal(hasDraftChanges(store.getState()), false)
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[1].parent_id, 'a')
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

test('impact attribution follows the whole operation across undo, redo and save rebase', async () => {
  const store = setup()
  store.dispatch(labelDraftStep({ label: '移动任务', directTaskIds: ['a', 'a'] }))
  store.dispatch(updateTasks([{ ...task, start_date: '2026-11-02T00:00:00' }]))
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[1], start_date: '2026-11-03T00:00:00' }]))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length, 1)
  assert.deepEqual(store.getState().draft.past[0].directTaskIds, ['a'])
  store.dispatch(undoDraft()); store.dispatch(redoDraft())
  assert.deepEqual(store.getState().draft.past[0].directTaskIds, ['a'])
  store.dispatch(beginDraftSave())
  const submitted = snapshotDraft(store.getState())
  store.dispatch(labelDraftStep({ label: '重命名', directTaskIds: ['b'] }))
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[1], name: 'During save' }]))
  await Promise.resolve()
  store.dispatch(finishDraftSave(submitted))
  assert.equal(store.getState().draft.past.length, 1)
  assert.equal(store.getState().draft.past[0].label, '重命名')
  assert.deepEqual(store.getState().draft.past[0].directTaskIds, ['b'])
  store.dispatch(undoDraft())
  assert.equal(hasDraftChanges(store.getState()), false)
})
test('a labeled no-op cannot attribute the next event to an unrelated task', async () => {
  const store = setup()
  store.dispatch(labelDraftStep({ label: 'No-op', directTaskIds: ['a'] }))
  await Promise.resolve()
  store.dispatch(updateTasks([{ ...store.getState().tasks.tasks[1], name: 'B edited' }]))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length, 1)
  assert.equal(store.getState().draft.past[0].directTaskIds, undefined)
  assert.equal(store.getState().draft.past[0].label, '编辑任务')
})

test('a preflight rejection preserves edits and undo; earlier uncertain writes remain protected', async () => {
  const { cancelDraftSave } = await import('../store/draftHistory.js')
  const store = setup(), before = snapshotDraft(store.getState())
  store.dispatch(updateTasks([{ ...task, name: 'Unsaved' }]))
  store.dispatch(beginDraftSave()); store.dispatch(cancelDraftSave())
  assert.equal(store.getState().draft.uncertain, false)
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), before)
  store.dispatch(redoDraft()); store.dispatch(beginDraftSave()); store.dispatch(failDraftSave())
  store.dispatch(beginDraftSave()); store.dispatch(cancelDraftSave()); store.dispatch(undoDraft())
  assert.equal(store.getState().draft.uncertain, true)
  assert.equal(store.getState().tasks.tasks[0].name, 'Unsaved')
})

test('reviewed reconciliation updates the save baseline while retaining a single undoable unsaved draft', async () => {
  const { reconcileDraft } = await import('../store/draftHistory.js')
  const store = setup(), baseline = snapshotDraft(store.getState())
  const remote = { ...baseline, tasks: baseline.tasks.map(t => ({ ...t, assignee: '后台责任人' })) }
  const current = { ...remote, tasks: remote.tasks.map(t => t.id === 'a' ? { ...t, name: '我的修改' } : t) }
  store.dispatch(reconcileDraft({ baseline: remote, current }))
  assert.deepEqual(store.getState().draft.baseline, remote)
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.equal(store.getState().draft.past.length, 1)
  store.dispatch(undoDraft()); assert.deepEqual(snapshotDraft(store.getState()), remote)
  store.dispatch(redoDraft()); assert.deepEqual(snapshotDraft(store.getState()), current)
  store.dispatch(beginDraftSave()); store.dispatch(finishDraftSave(current))
  assert.equal(hasDraftChanges(store.getState()), false)
})
