import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Task, Project } from '../types'
import { makePlanBaseline, baselinesEqual, baselineVariance } from '../lib/planBaseline'
import { findPlanSaveConflicts, findPlanSaveMismatches } from '../lib/planSaveVerification'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, undoDraft, redoDraft, beginDraftSave, finishDraftSave, hasDraftChanges } from '../store/draftHistory'
import { setCurrentProject, setPlanBaseline } from '../store/slices/projectSlice'
import { setTasks } from '../store/slices/tasksSlice'

const task = { id: 'task', project_id: 'p', name: 'A', task_code: '1', parent_id: null, assignee: null,
  start_date: '2030-01-01T09:00:00', end_date: '2030-01-01T10:00:00', duration: 60, duration_unit: 'minute',
  percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '' } as Task
const version = { id: 'v1', name: '批准计划', created_at: '2030-01-01T12:00:00Z', snapshot: { tasks: [task] } }
const baseline = makePlanBaseline(version, 'b1', '初次批准')
const plan = { tasks: [task], dependencies: [], lines: [], statusDate: null, planningStatus: 'draft' as const, planBaseline: null }

test('a fixed baseline is an independent projection, unaffected by same-date version replacement', () => {
  const source = structuredClone(version), fixed = makePlanBaseline(source, 'b1', ' 初次批准 ')
  source.snapshot.tasks[0].end_date = '2030-01-02T10:00:00'
  source.name = '重新确认'
  assert.equal(fixed.tasks[0].end_date, task.end_date)
  assert.equal(fixed.sourceVersionName, '批准计划')
  assert.equal(fixed.reason, '初次批准')
  assert.ok(baselinesEqual(fixed, baseline))
  assert.equal(baselinesEqual(null, baseline), false)
})

test('variance uses stable task IDs and signed minute values; new tasks have no fictitious baseline', () => {
  assert.deepEqual(baselineVariance({ ...task, name: '改名', start_date: '2030-01-01T09:15:00', end_date: '2030-01-01T09:45:00', duration: 30 }, baseline), { start: 15, finish: -15, duration: -30 })
  assert.equal(baselineVariance({ ...task, id: 'new' }, baseline), null)
  assert.equal(baselineVariance(task, null), null)
})

test('baseline changes participate in preflight conflicts and authoritative readback', () => {
  const selected = { ...plan, planBaseline: baseline }
  assert.ok(findPlanSaveMismatches(selected, plan).some(s => s.includes('固定基线')))
  assert.deepEqual(findPlanSaveMismatches(selected, structuredClone(selected)), [])
  const remote = { ...plan, planBaseline: { ...baseline, id: 'someone-else', reason: '另一个会话' } }
  assert.ok(findPlanSaveConflicts(plan, remote, selected).some(s => s.includes('固定基线')))
  assert.deepEqual(findPlanSaveConflicts(plan, selected, selected), [])
})

test('baseline selection is undoable, preserves dates, and retains a newer selection made during saving', async () => {
  const store = configureStore({ reducer: rootReducer, middleware: g => g().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', planning_status: 'draft' } as Project))
  store.dispatch(setTasks({ tasks: [task], dependencies: [] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: { ...plan, descriptions: {} } }))
  store.dispatch(setPlanBaseline({ projectId: 'p', baseline }))
  await Promise.resolve()
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.equal(store.getState().draft.past.length, 1)
  store.dispatch(undoDraft()); assert.equal(store.getState().project.currentProject?.plan_baseline, null)
  store.dispatch(redoDraft()); assert.ok(baselinesEqual(store.getState().project.currentProject?.plan_baseline, baseline))
  const submitted = snapshotDraft(store.getState())
  store.dispatch(beginDraftSave())
  const newer = { ...baseline, id: 'b2', reason: '重新批准' }
  store.dispatch(setPlanBaseline({ projectId: 'p', baseline: newer }))
  await Promise.resolve()
  store.dispatch(finishDraftSave(submitted))
  assert.ok(baselinesEqual(store.getState().draft.baseline?.planBaseline, baseline))
  assert.ok(baselinesEqual(store.getState().project.currentProject?.plan_baseline, newer))
  assert.equal(hasDraftChanges(store.getState()), true)
  assert.deepEqual(store.getState().tasks.tasks, [task])
  store.dispatch(undoDraft())
  assert.ok(baselinesEqual(store.getState().project.currentProject?.plan_baseline, baseline))
  assert.equal(hasDraftChanges(store.getState()), false)
})
