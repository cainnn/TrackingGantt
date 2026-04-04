import { configureStore } from '@reduxjs/toolkit'
import authReducer from './slices/authSlice'
import projectReducer from './slices/projectSlice'
import tasksReducer from './slices/tasksSlice'
import projectLinesReducer from './slices/projectLinesSlice'
import versionsReducer from './slices/versionsSlice'

export const store = configureStore({
  reducer: {
    auth: authReducer,
    project: projectReducer,
    tasks: tasksReducer,
    projectLines: projectLinesReducer,
    versions: versionsReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
