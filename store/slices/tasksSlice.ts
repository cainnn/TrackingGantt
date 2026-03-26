import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Task, Dependency } from '@/types'

interface Snapshot { tasks: Task[]; dependencies: Dependency[] }

interface TasksState {
  tasks: Task[]
  dependencies: Dependency[]
  clipboard: Task[]
  selectedIds: string[]
  loading: boolean
  error: string | null
  undoStack: Snapshot[]
  redoStack: Snapshot[]
}

const initialState: TasksState = {
  tasks: [],
  dependencies: [],
  clipboard: [],
  selectedIds: [],
  loading: false,
  error: null,
  undoStack: [],
  redoStack: [],
}

const tasksSlice = createSlice({
  name: 'tasks',
  initialState,
  reducers: {
    setTasks(state, action: PayloadAction<{ tasks: Task[]; dependencies: Dependency[] }>) {
      state.tasks = action.payload.tasks
      state.dependencies = action.payload.dependencies
      state.undoStack = []
      state.redoStack = []
    },
    addTasks(state, action: PayloadAction<Task[]>) {
      state.tasks.push(...action.payload)
    },
    updateTasks(state, action: PayloadAction<Task[]>) {
      for (const updated of action.payload) {
        const idx = state.tasks.findIndex(t => t.id === updated.id)
        if (idx !== -1) state.tasks[idx] = updated
      }
    },
    deleteTasks(state, action: PayloadAction<string[]>) {
      state.tasks = state.tasks.filter(t => !action.payload.includes(t.id))
      state.selectedIds = state.selectedIds.filter(id => !action.payload.includes(id))
    },
    copyTasks(state, action: PayloadAction<string[]>) {
      state.clipboard = state.tasks.filter(t => action.payload.includes(t.id))
    },
    clearClipboard(state) {
      state.clipboard = []
    },
    setSelectedIds(state, action: PayloadAction<string[]>) {
      state.selectedIds = action.payload
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload
    },
    addDependency(state, action: PayloadAction<Dependency>) {
      state.dependencies.push(action.payload)
    },
    removeDependency(state, action: PayloadAction<string>) {
      state.dependencies = state.dependencies.filter(d => d.id !== action.payload)
    },
    updateDependency(state, action: PayloadAction<{ id: string; type?: number; lag?: number }>) {
      const idx = state.dependencies.findIndex(d => d.id === action.payload.id)
      if (idx !== -1) {
        if (action.payload.type !== undefined) state.dependencies[idx].type = action.payload.type
        if (action.payload.lag  !== undefined) state.dependencies[idx].lag  = action.payload.lag
      }
    },
    clearTasks(state) {
      state.tasks = []
      state.dependencies = []
      state.clipboard = []
      state.selectedIds = []
      state.undoStack = []
      state.redoStack = []
    },
    // ── Undo / Redo ──────────────────────────────────────────────────────
    saveSnapshot(state) {
      state.undoStack.push({ tasks: [...state.tasks], dependencies: [...state.dependencies] })
      if (state.undoStack.length > 50) state.undoStack.shift()
      state.redoStack = []
    },
    undo(state) {
      if (state.undoStack.length === 0) return
      state.redoStack.push({ tasks: [...state.tasks], dependencies: [...state.dependencies] })
      const prev = state.undoStack.pop()!
      state.tasks = prev.tasks
      state.dependencies = prev.dependencies
    },
    redo(state) {
      if (state.redoStack.length === 0) return
      state.undoStack.push({ tasks: [...state.tasks], dependencies: [...state.dependencies] })
      const next = state.redoStack.pop()!
      state.tasks = next.tasks
      state.dependencies = next.dependencies
    },
  },
})

export const {
  setTasks, addTasks, updateTasks, deleteTasks,
  copyTasks, clearClipboard, setSelectedIds,
  setLoading, setError, clearTasks,
  addDependency, removeDependency, updateDependency,
  saveSnapshot, undo, redo,
} = tasksSlice.actions
export default tasksSlice.reducer
