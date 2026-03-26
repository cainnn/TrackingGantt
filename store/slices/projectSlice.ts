import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Project } from '@/types'

interface ProjectState {
  projects: Project[]
  currentProject: Project | null
  loading: boolean
  error: string | null
}

const initialState: ProjectState = {
  projects: [],
  currentProject: null,
  loading: false,
  error: null,
}

const projectSlice = createSlice({
  name: 'project',
  initialState,
  reducers: {
    setProjects(state, action: PayloadAction<Project[]>) {
      state.projects = action.payload
    },
    addProject(state, action: PayloadAction<Project>) {
      state.projects.unshift(action.payload)
    },
    updateProject(state, action: PayloadAction<Project>) {
      const idx = state.projects.findIndex(p => p.id === action.payload.id)
      if (idx !== -1) state.projects[idx] = action.payload
      if (state.currentProject?.id === action.payload.id) {
        state.currentProject = action.payload
      }
    },
    deleteProject(state, action: PayloadAction<string>) {
      state.projects = state.projects.filter(p => p.id !== action.payload)
      if (state.currentProject?.id === action.payload) state.currentProject = null
    },
    setCurrentProject(state, action: PayloadAction<Project | null>) {
      state.currentProject = action.payload
    },
    setStatusDate(state, action: PayloadAction<{ projectId: string; statusDate: string | null }>) {
      const { projectId, statusDate } = action.payload
      const project = state.projects.find(p => p.id === projectId)
      if (project) project.status_date = statusDate
      if (state.currentProject?.id === projectId) {
        state.currentProject.status_date = statusDate
      }
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload
    },
  },
})

export const {
  setProjects, addProject, updateProject, deleteProject,
  setCurrentProject, setStatusDate, setLoading, setError,
} = projectSlice.actions
export default projectSlice.reducer
