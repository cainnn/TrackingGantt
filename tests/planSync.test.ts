import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, resetDraft, beginDraftSave, finishDraftSave, failDraftSave, undoDraft } from '../store/draftHistory'
import { setCurrentProject } from '../store/slices/projectSlice'
import { setTasks, updateTasks, setViewSnapshot } from '../store/slices/tasksSlice'
import { decidePlanSync } from '../lib/planSync'
import type { Task } from '../types'

function setup() {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: '2026-11-01', created_at: '' }))
  const task: Task = { id: 'a', project_id: 'p', parent_id: null, task_code: '1', name: 'A', assignee: null,
    start_date: '2026-11-01T00:00:00', end_date: '2026-11-02T00:00:00', duration: 1440, duration_unit: 'minute',
    percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '' }
  store.dispatch(setTasks({ tasks: [task], dependencies: [] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  const source = store.getState().draft.baseline!
  const remote = { ...source, tasks: [{ ...task, name: 'Other browser' }] }
  return { store, source, remote, decide: (busy = false) => decidePlanSync(store.getState(), 'p', source, remote, busy) }
}
test('clean plans adopt remote snapshots, while identical business data is a no-op', () => {
  const { store, source, remote, decide } = setup()
  assert.equal(decide(), 'apply')
  assert.equal(decidePlanSync(store.getState(), 'p', source, { ...source, tasks: source.tasks.map(t => ({ ...t, updated_at: 'later' })) }, false), 'current')
  store.dispatch(resetDraft(remote))
  assert.equal(store.getState().tasks.tasks[0].name, 'Other browser')
})
test('unsaved edits, open editors, drags and redo history defer replacement', async () => {
  const { store, source, decide } = setup()
  assert.equal(decide(true), 'defer')
  store.dispatch(updateTasks([{ ...source.tasks[0], name: 'Local' }]))
  assert.equal(decide(), 'defer')
  await Promise.resolve()
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].name, 'A')
  assert.equal(decide(), 'defer')
  assert.equal(store.getState().draft.future.length, 1)
})
test('saving, uncertain writes and viewing history never auto-replace the working state', () => {
  for (const mode of ['saving', 'uncertain', 'history']) {
    const { store, source, decide } = setup()
    if (mode === 'history') store.dispatch(setViewSnapshot({ versionId: 'v', versionName: 'V', tasks: source.tasks, dependencies: [] }))
    else { store.dispatch(beginDraftSave()); if (mode === 'uncertain') store.dispatch(failDraftSave()) }
    assert.equal(decide(), 'defer', mode)
  }
})
test('delayed responses after an own save or baseline reconciliation are stale', () => {
  const { store, remote, decide } = setup()
  store.dispatch(beginDraftSave())
  store.dispatch(finishDraftSave({ ...remote, tasks: remote.tasks.map(t => ({ ...t, name: 'Saved locally' })) }))
  assert.equal(decide(), 'stale')
  assert.equal(store.getState().tasks.tasks[0].name, 'Saved locally')
})
test('project switches reject the previous project response even with an equal-looking plan', () => {
  const { store, source, remote } = setup()
  assert.equal(decidePlanSync(store.getState(), 'another-project', source, remote, false), 'stale')
})
