import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { cascadeDragSuccessors } from '../lib/clientDragScheduling'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, beginDraftSave, finishDraftSave, undoDraft, redoDraft, hasDraftChanges } from '../store/draftHistory'
import { setTasks, updateTasks } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'
import type { Task, Dependency } from '../types'

const purchase: Task = {
  id: 'purchase', project_id: 'p', parent_id: null, task_code: '1', name: '提交采购', assignee: null,
  start_date: '2026-11-10T00:00:00', end_date: '2026-11-16T00:00:00', duration: 8640,
  duration_unit: 'minute', percent_done: 100, is_milestone: false, auto_schedule: false,
  note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '',
}
const delivery: Task = {
  ...purchase, id: 'delivery', task_code: '2', name: '设备到货',
  start_date: '2026-11-19T00:00:00', end_date: '2026-12-10T00:00:00', duration: 30240, percent_done: 5,
}
const dependency: Dependency = {
  id: 'd', project_id: 'p', from_task_id: purchase.id, to_task_id: delivery.id, type: 2, lag: -14400,
}
const resized = { ...purchase, end_date: '2026-11-19T00:00:00', duration: 12960 }

test('resizing after a confirmed save keeps a manual successor and undo at the saved version', async () => {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: '2026-11-20T00:00:00', created_at: '' }))
  store.dispatch(setTasks({ tasks: [purchase, { ...delivery, start_date: '2026-11-09T00:00:00', end_date: '2026-11-30T00:00:00' }], dependencies: [dependency] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  store.dispatch(updateTasks([delivery]))
  store.dispatch(beginDraftSave())
  const saved = snapshotDraft(store.getState())
  store.dispatch(finishDraftSave(saved))

  const preview = cascadeDragSuccessors(store.getState().tasks.tasks, [dependency], { purchase: resized }, ['delivery'])
  store.dispatch(updateTasks(Object.values(preview)))
  await Promise.resolve()
  assert.deepEqual(store.getState().tasks.tasks.find(t => t.id === 'delivery'), delivery)
  assert.equal(store.getState().tasks.tasks[0].end_date, '2026-11-19T00:00:00')
  assert.equal(store.getState().project.currentProject?.status_date, '2026-11-20T00:00:00')
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.deepEqual(store.getState().draft.baseline, saved)
  assert.equal(store.getState().draft.past.length, 1)
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), saved)
  store.dispatch(undoDraft())
  assert.deepEqual(snapshotDraft(store.getState()), saved)
  store.dispatch(redoDraft())
  assert.equal(store.getState().tasks.tasks[0].end_date, '2026-11-19T00:00:00')
  assert.deepEqual(store.getState().tasks.tasks[1], delivery)
})

test('automatic successors retain FS, SS, FF, SF and minute lag behavior during dragging', () => {
  const pred = { ...purchase, start_date: '2026-11-10T09:00:00', end_date: '2026-11-10T10:00:00', duration: 60 }
  const next = { ...delivery, auto_schedule: true, start_date: '2026-11-11T09:00:00', end_date: '2026-11-11T10:30:00', duration: 90 }
  const expected = ['09:15:00', '07:45:00', '10:15:00', '08:45:00']
  for (const type of [0, 1, 2, 3]) {
    const update = cascadeDragSuccessors([pred, next], [{ ...dependency, type, lag: 15 }], { purchase: pred }, ['delivery']).delivery
    assert.equal(update.start_date, `2026-11-10T${expected[type]}`)
    assert.equal(update.duration, 90)
  }
  const preview = cascadeDragSuccessors([purchase, { ...delivery, auto_schedule: true }], [dependency], { purchase: resized }, ['delivery'])
  assert.equal(preview.delivery.start_date, '2026-11-09T00:00:00')
  assert.equal(preview.delivery.end_date, '2026-11-30T00:00:00')
  assert.equal(cascadeDragSuccessors([purchase, { ...delivery, auto_schedule: true }], [{ ...dependency, active: false }], { purchase: resized }, ['delivery']).delivery, undefined)
})

test('summary gestures move their explicit manual children while preserving external manual successors', () => {
  const child = { ...purchase, parent_id: 'summary' }
  const movedChild = { ...child, start_date: '2026-11-13T00:00:00', end_date: '2026-11-19T00:00:00' }
  const auto = { ...delivery, id: 'auto', auto_schedule: true }
  const preview = cascadeDragSuccessors([child, delivery, auto], [dependency, { ...dependency, id: 'auto-dep', to_task_id: 'auto' }], { purchase: movedChild }, ['delivery', 'auto'])
  assert.deepEqual(preview.purchase, movedChild)
  assert.equal(preview.delivery, undefined)
  assert.equal(preview.auto.start_date, '2026-11-09T00:00:00')
  // An explicitly dragged manual successor still moves normally.
  const movedDelivery = { ...delivery, start_date: '2026-11-20T00:00:00', end_date: '2026-12-11T00:00:00' }
  assert.deepEqual(cascadeDragSuccessors([child, delivery], [dependency], { delivery: movedDelivery }, []).delivery, movedDelivery)
})

test('a manual task stops upstream shifts from propagating through its unchanged dates', () => {
  const auto = { ...delivery, id: 'auto', auto_schedule: true, start_date: '2026-12-10T00:00:00', end_date: '2026-12-11T00:00:00', duration: 1440 }
  const nextDependency = { ...dependency, id: 'next', from_task_id: 'delivery', to_task_id: 'auto', lag: 0 }
  const preview = cascadeDragSuccessors([purchase, delivery, auto], [dependency, nextDependency], { purchase: resized }, ['auto', 'delivery'])
  assert.deepEqual(Object.keys(preview), ['purchase'])
})
