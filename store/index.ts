import { configureStore } from '@reduxjs/toolkit'
import { rootReducer, createDraftMiddleware } from './draftHistory'

export const store = configureStore({
  reducer: rootReducer,
  middleware: getDefault => getDefault().concat(createDraftMiddleware()),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
