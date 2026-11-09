import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { earliestTaskStart } from '../lib/projectStart'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, undoDraft, redoDraft, resetDraft, beginDraftSave, finishDraftSave, hasDraftChanges } from '../store/draftHistory'
import { setCurrentProject } from '../store/slices/projectSlice'
import { setTasks, updateTasks, deleteTasks } from '../store/slices/tasksSlice'
import type { Task } from '../types'

const task = (id: string, start: string | null, extra: Partial<Task> = {}): Task => ({
  id, project_id: 'p', parent_id: null, task_code: id, name: id, start_date: start, end_date: '2026-08-27T00:00:00', duration: 12960,
  assignee: null, duration_unit: 'day', percent_done: 0, is_milestone: false, note: null, order_index: 0,
  is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra,
})
const start = (store: ReturnType<typeof setup>) => store.getState().project.currentProject!.start_date
function setup() {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: '2026-11-06', end_date: null, status_date: null, created_at: '' }))
  store.dispatch(setTasks({ tasks: [task('立项', '2026-08-10'), task('封网', '2026-08-18')], dependencies: [] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  return store
}
test('project start is the minimum live task date, including milestones, summaries and inactive tasks', () => {
  assert.equal(earliestTaskStart([task('a', '2026-08-18'), task('deleted', '2020-01-01', { is_deleted: true }), task('empty', null), task('bad', '2026-02-30'), task('inactive', '2026-08-10T09:35:00', { inactive: true })]), '2026-08-10T09:35:00')
  assert.equal(earliestTaskStart([task('milestone', '2026-08-10T08:14:00', { is_milestone: true }), task('summary', '2026-08-11')]), '2026-08-10T08:14:00')
  assert.equal(earliestTaskStart([]), null)
  assert.equal(earliestTaskStart([task('missing', null), task('deleted', '2026-01-01', { is_deleted: true })]), null)
})
test('loading a plan with the reported CDN dates derives August rather than clamping tasks to November', () => {
  const store = setup()
  assert.equal(start(store), '2026-08-10T00:00:00')
  assert.equal(store.getState().tasks.tasks[1].start_date, '2026-08-18')
  assert.equal(store.getState().tasks.tasks[1].end_date, '2026-08-27T00:00:00')
  assert.equal(hasDraftChanges(store.getState()), false)
})
test('advancing, postponing and deleting the earliest task update immediately and follow undo/redo/discard', async () => {
  const store = setup(), baseline = snapshotDraft(store.getState())
  store.dispatch(updateTasks([task('立项', '2026-08-20')]))
  await Promise.resolve()
  assert.equal(start(store), '2026-08-18T00:00:00')
  store.dispatch(undoDraft()); assert.equal(start(store), '2026-08-10T00:00:00')
  store.dispatch(redoDraft()); assert.equal(start(store), '2026-08-18T00:00:00')
  store.dispatch(deleteTasks(['封网'])); await Promise.resolve()
  assert.equal(start(store), '2026-08-20T00:00:00')
  store.dispatch(deleteTasks(['立项'])); await Promise.resolve(); assert.equal(start(store), null)
  store.dispatch(resetDraft(baseline)); assert.equal(start(store), '2026-08-10T00:00:00')
})
test('later local date edits survive save reconciliation and undo returns to the saved start', async () => {
  const store = setup()
  store.dispatch(beginDraftSave()); const saved = snapshotDraft(store.getState())
  store.dispatch(updateTasks([task('立项', '2026-08-01')]))
  await Promise.resolve(); store.dispatch(finishDraftSave(saved))
  assert.equal(start(store), '2026-08-01T00:00:00')
  store.dispatch(undoDraft()); assert.equal(start(store), '2026-08-10T00:00:00')
  assert.equal(hasDraftChanges(store.getState()), false)
})
