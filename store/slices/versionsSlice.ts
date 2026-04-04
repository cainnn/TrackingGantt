import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ProjectVersion } from '@/types'

interface VersionsState {
  versions: ProjectVersion[]
  loading: boolean
}

const initialState: VersionsState = {
  versions: [],
  loading: false,
}

const versionsSlice = createSlice({
  name: 'versions',
  initialState,
  reducers: {
    setVersions(state, action: PayloadAction<ProjectVersion[]>) {
      state.versions = action.payload
    },
    addVersion(state, action: PayloadAction<ProjectVersion>) {
      state.versions.unshift(action.payload)
    },
    updateVersion(state, action: PayloadAction<{ id: string; name?: string; description?: string }>) {
      const idx = state.versions.findIndex(v => v.id === action.payload.id)
      if (idx !== -1) {
        if (action.payload.name !== undefined) state.versions[idx].name = action.payload.name
        if (action.payload.description !== undefined) state.versions[idx].description = action.payload.description
      }
    },
    removeVersion(state, action: PayloadAction<string>) {
      state.versions = state.versions.filter(v => v.id !== action.payload)
    },
    setVersionsLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
    clearVersions(state) {
      state.versions = []
    },
  },
})

export const {
  setVersions, addVersion, updateVersion, removeVersion,
  setVersionsLoading, clearVersions,
} = versionsSlice.actions
export default versionsSlice.reducer
