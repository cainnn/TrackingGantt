import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { changeReasonsComplete, normalizePlanningStatus, isPlanningStatus } from '../lib/planningStatus'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, hasDraftChanges, undoDraft, redoDraft, resetDraft, beginDraftSave, finishDraftSave } from '../store/draftHistory'
import { setCurrentProject, setPlanningStatus } from '../store/slices/projectSlice'
import { setViewSnapshot } from '../store/slices/tasksSlice'

function setup() {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: null, planning_status: 'draft', created_at: '' }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  return store
}
test('draft plans allow blank reasons while stable plans require both primary task and dependency reasons', () => {
  assert.equal(changeReasonsComplete('draft', ['manual', 'primary'], ['dep'], {}, {}), true)
  assert.equal(changeReasonsComplete('stable', ['manual', 'primary'], ['dep'], {}, {}), false)
  const reasons = { manual: '设备延期', primary: '调整工期' }
  assert.equal(changeReasonsComplete('stable', Object.keys(reasons), ['dep'], reasons, { dep: '  ' }), false)
  assert.equal(changeReasonsComplete('stable', Object.keys(reasons), ['dep'], reasons, { dep: '配合现场顺序' }), true)
  assert.equal(changeReasonsComplete('stable', [], [], {}, {}), true)
})
test('legacy projects and snapshots remain stable and unknown API values are rejected', () => {
  assert.equal(normalizePlanningStatus(undefined), 'stable')
  assert.equal(normalizePlanningStatus('draft'), 'draft')
  for (const value of [undefined, null, '', 'published', 1]) assert.equal(isPlanningStatus(value), false)
  assert.equal(isPlanningStatus('stable'), true)
  assert.equal(isPlanningStatus('draft'), true)
})
test('plan state changes are undoable drafts and do not change the saved baseline', async () => {
  const store = setup(), baseline = snapshotDraft(store.getState())
  store.dispatch(setPlanningStatus({ projectId: 'p', planningStatus: 'stable' }))
  await Promise.resolve()
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.equal(store.getState().draft.baseline?.planningStatus, 'draft')
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), baseline)
  store.dispatch(redoDraft())
  assert.equal(store.getState().project.currentProject?.planning_status, 'stable')
  store.dispatch(resetDraft(baseline))
  assert.equal(hasDraftChanges(store.getState()), false)
  assert.equal(store.getState().project.currentProject?.planning_status, 'draft')
})
test('saving plan state rebases later edits and undo cannot cross the confirmed state', async () => {
  const store = setup()
  store.dispatch(setPlanningStatus({ projectId: 'p', planningStatus: 'stable' }))
  store.dispatch(beginDraftSave())
  const submitted = snapshotDraft(store.getState())
  store.dispatch(setPlanningStatus({ projectId: 'p', planningStatus: 'draft' }))
  await Promise.resolve()
  store.dispatch(finishDraftSave(submitted))
  assert.equal(store.getState().project.currentProject?.planning_status, 'draft')
  assert.equal(store.getState().draft.baseline?.planningStatus, 'stable')
  assert.equal(hasDraftChanges(store.getState()), true)
  store.dispatch(undoDraft())
  assert.equal(store.getState().project.currentProject?.planning_status, 'stable')
  assert.equal(hasDraftChanges(store.getState()), false)
  store.dispatch(undoDraft())
  assert.equal(store.getState().project.currentProject?.planning_status, 'stable')
})
test('history viewing cannot change a project plan state', () => {
  const store = setup()
  store.dispatch(setViewSnapshot({ tasks: [], dependencies: [], versionId: 'v', versionName: '历史版本', planningStatus: 'stable' }))
  store.dispatch(setPlanningStatus({ projectId: 'p', planningStatus: 'stable' }))
  assert.equal(store.getState().project.currentProject?.planning_status, 'draft')
  assert.equal(hasDraftChanges(store.getState()), false)
})
