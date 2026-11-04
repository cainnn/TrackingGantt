import { combineReducers, createAction, type Middleware, type UnknownAction } from '@reduxjs/toolkit'
import auth from './slices/authSlice'
import project from './slices/projectSlice'
import tasks from './slices/tasksSlice'
import projectLines from './slices/projectLinesSlice'
import versions from './slices/versionsSlice'
import type { Task, Dependency, ProjectLine, PlanningStatus } from '../types'
import { buildSaveDiff, hasAnyDiff, mergeSavedRecords } from '../lib/clientSave'
import { toDateTimeStr } from '../lib/clientTime'
import { normalizePlanningStatus } from '../lib/planningStatus'

export interface DraftSnapshot {
  tasks: Task[]
  dependencies: Dependency[]
  statusDate: string | null
  planningStatus?: PlanningStatus
  lines: ProjectLine[]
  descriptions: Record<string, string>
}
interface Step { before: DraftSnapshot; after: DraftSnapshot; label: string }
interface DraftHistory {
  projectId: string | null
  baseline: DraftSnapshot | null
  past: Step[]
  future: Step[]
  saving: boolean
  uncertain: boolean
  submitted: DraftSnapshot | null
  duringSave: Step[]
}
const empty: DraftHistory = {
  projectId: null, baseline: null, past: [], future: [], saving: false,
  uncertain: false, submitted: null, duringSave: [],
}
export const initializeDraft = createAction<{ projectId: string; baseline: DraftSnapshot }>('draft/initialize')
export const undoDraft = createAction('draft/undo')
export const redoDraft = createAction('draft/redo')
export const beginDraftSave = createAction('draft/beginSave')
export const failDraftSave = createAction('draft/failSave')
export const finishDraftSave = createAction<DraftSnapshot>('draft/finishSave')
export const resetDraft = createAction<DraftSnapshot>('draft/reset')
export const labelDraftStep = createAction<string>('draft/label')
const recordStep = createAction<{ before: DraftSnapshot; label: string }>('draft/record')
const combined = combineReducers({ auth, project, tasks, projectLines, versions, draft: (s: DraftHistory = empty) => s })
export type DraftRootState = ReturnType<typeof combined>

export function snapshotDraft(state: DraftRootState): DraftSnapshot {
  return {
    tasks: state.tasks.tasks, dependencies: state.tasks.dependencies,
    statusDate: toDateTimeStr(state.project.currentProject?.status_date ?? null),
    planningStatus: normalizePlanningStatus(state.project.currentProject?.planning_status),
    lines: state.projectLines.lines, descriptions: state.tasks.editDescriptions,
  }
}
export function linesEqual(a: ProjectLine[], b: ProjectLine[]): boolean {
  const normalized = (lines: ProjectLine[]) => lines.map(l => ({
    id: l.id, name: l.name, line_date: l.line_date.slice(0, 10), color: l.color, visible: l.visible,
  })).sort((x, y) => x.id.localeCompare(y.id))
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b))
}
export function draftsEqual(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return toDateTimeStr(a.statusDate) === toDateTimeStr(b.statusDate)
    && normalizePlanningStatus(a.planningStatus) === normalizePlanningStatus(b.planningStatus)
    && linesEqual(a.lines, b.lines)
    && !hasAnyDiff(buildSaveDiff(a.tasks, a.dependencies, b.tasks, b.dependencies))
}
export function hasDraftChanges(state: DraftRootState): boolean {
  return !!state.draft.baseline && !draftsEqual(state.draft.baseline, snapshotDraft(state))
}
function restore(state: DraftRootState, value: DraftSnapshot): DraftRootState {
  const base = state.draft.baseline ?? value
  const diff = buildSaveDiff(base.tasks, base.dependencies, value.tasks, value.dependencies)
  const dirtyIds = [...new Set([...diff.tasksToAdd, ...diff.tasksToUpdate].map(t => t.id).concat(diff.tasksToDelete))]
  return {
    ...state,
    tasks: { ...state.tasks, tasks: value.tasks, dependencies: value.dependencies,
      dirtyIds, editDescriptions: value.descriptions,
      selectedIds: state.tasks.selectedIds.filter(id => value.tasks.some(t => t.id === id && !t.is_deleted)),
    },
    projectLines: { ...state.projectLines, lines: value.lines },
    project: { ...state.project,
      currentProject: state.project.currentProject ? { ...state.project.currentProject, status_date: value.statusDate, planning_status: normalizePlanningStatus(value.planningStatus) } : null,
      projects: state.project.projects.map(p => p.id === state.draft.projectId ? { ...p, status_date: value.statusDate, planning_status: normalizePlanningStatus(value.planningStatus) } : p),
    },
  }
}
function rebase(saved: DraftSnapshot, submitted: DraftSnapshot, current: DraftSnapshot): DraftSnapshot {
  return {
    tasks: mergeSavedRecords(saved.tasks, submitted.tasks, current.tasks),
    dependencies: mergeSavedRecords(saved.dependencies, submitted.dependencies, current.dependencies),
    lines: mergeSavedRecords(saved.lines, submitted.lines, current.lines),
    statusDate: toDateTimeStr(current.statusDate) === toDateTimeStr(submitted.statusDate) ? saved.statusDate : current.statusDate,
    planningStatus: normalizePlanningStatus(current.planningStatus) === normalizePlanningStatus(submitted.planningStatus)
      ? normalizePlanningStatus(saved.planningStatus) : normalizePlanningStatus(current.planningStatus),
    descriptions: Object.fromEntries(Object.entries(current.descriptions).filter(([id, text]) => submitted.descriptions[id] !== text)),
  }
}
export function rootReducer(state: DraftRootState | undefined, action: UnknownAction): DraftRootState {
  let next = combined(state, action)
  if (action.type === 'tasks/clearTasks' || action.type === 'auth/logout') return { ...next, draft: empty }
  if (initializeDraft.match(action)) {
    const baseline = action.payload.baseline
    const current = snapshotDraft(next)
    return { ...next, draft: { ...empty, projectId: action.payload.projectId, baseline,
      past: draftsEqual(baseline, current) ? [] : [{ before: baseline, after: current, label: '自动排程' }],
    } }
  }
  const history = next.draft
  if (!history.baseline) return next
  if (recordStep.match(action)) {
    const after = snapshotDraft(next)
    if (draftsEqual(action.payload.before, after)) return next
    const step = { ...action.payload, after }
    return { ...next, draft: { ...history, past: [...history.past, step].slice(-100), future: [],
      duringSave: history.submitted ? [...history.duringSave, step] : history.duringSave,
    } }
  }
  if (undoDraft.match(action) || redoDraft.match(action)) {
    if (history.saving || history.uncertain || next.tasks.viewSnapshot) return next
    const undo = undoDraft.match(action)
    const step = (undo ? history.past : history.future).at(-1)
    if (!step) return next
    next = restore(next, undo ? step.before : step.after)
    return { ...next, draft: { ...history,
      past: undo ? history.past.slice(0, -1) : [...history.past, step],
      future: undo ? [...history.future, step] : history.future.slice(0, -1),
    } }
  }
  if (beginDraftSave.match(action)) return { ...next, draft: { ...history,
    saving: true, submitted: snapshotDraft(next), duringSave: [], future: [],
  } }
  if (failDraftSave.match(action)) return { ...next, draft: { ...history, saving: false, uncertain: true } }
  if (finishDraftSave.match(action)) {
    const saved = action.payload
    const submitted = history.submitted ?? snapshotDraft(next)
    const current = rebase(saved, submitted, snapshotDraft(next))
    const past = history.duringSave.map(step => ({ ...step,
      before: rebase(saved, submitted, step.before), after: rebase(saved, submitted, step.after),
    })).filter(step => !draftsEqual(step.before, step.after)).slice(-100)
    next = { ...next, draft: { ...empty, projectId: history.projectId, baseline: saved, past } }
    return restore(next, current)
  }
  if (resetDraft.match(action)) {
    next = { ...next, draft: { ...empty, projectId: history.projectId, baseline: action.payload } }
    return restore(next, action.payload)
  }
  return next
}

// A user event may dispatch several synchronous updates (task, dependencies,
// cascade and reason). Capture the event as one step, never a network request.
// Explicit save/reset/undo actions flush the event before crossing a boundary.
const mutations = new Set([
  'tasks/setTasks', 'tasks/addTasks', 'tasks/updateTasks', 'tasks/deleteTasks',
  'tasks/addDependency', 'tasks/removeDependency', 'tasks/updateDependency',
  'project/setStatusDate', 'project/setPlanningStatus', 'projectLines/setProjectLines', 'projectLines/addProjectLine',
  'projectLines/updateProjectLine', 'projectLines/removeProjectLine',
])
export const createDraftMiddleware = (): Middleware<{}, DraftRootState> => api => {
  let before: DraftSnapshot | null = null
  let label = '编辑任务'
  const flush = () => {
    if (!before) return
    const snapshot = before
    before = null
    api.dispatch(recordStep({ before: snapshot, label }))
    label = '编辑任务'
  }
  return next => action => {
    const typed = action as UnknownAction
    const state = api.getState()
    if (mutations.has(typed.type) && state.draft.baseline && (state.auth.user?.role === 'view' || state.tasks.viewSnapshot)) return action
    if (labelDraftStep.match(typed)) { flush(); label = typed.payload; return next(action) }
    if (typed.type.startsWith('draft/') && typed.type !== recordStep.type || typed.type === 'tasks/clearTasks') flush()
    if (mutations.has(typed.type) && api.getState().draft.baseline && !before) {
      before = snapshotDraft(api.getState())
      queueMicrotask(flush)
    }
    return next(action)
  }
}
