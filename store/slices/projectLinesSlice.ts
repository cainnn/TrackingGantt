import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ProjectLine } from '@/types'

interface ProjectLinesState {
  lines: ProjectLine[]
  loading: boolean
}

const initialState: ProjectLinesState = {
  lines: [],
  loading: false,
}

const projectLinesSlice = createSlice({
  name: 'projectLines',
  initialState,
  reducers: {
    setProjectLines(state, action: PayloadAction<ProjectLine[]>) {
      state.lines = action.payload
    },
    addProjectLine(state, action: PayloadAction<ProjectLine>) {
      state.lines.push(action.payload)
    },
    updateProjectLine(state, action: PayloadAction<ProjectLine>) {
      const idx = state.lines.findIndex(l => l.id === action.payload.id)
      if (idx !== -1) state.lines[idx] = action.payload
    },
    removeProjectLine(state, action: PayloadAction<string>) {
      state.lines = state.lines.filter(l => l.id !== action.payload)
    },
    clearProjectLines(state) {
      state.lines = []
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
  },
})

export const {
  setProjectLines, addProjectLine, updateProjectLine,
  removeProjectLine, clearProjectLines, setLoading,
} = projectLinesSlice.actions
export default projectLinesSlice.reducer
