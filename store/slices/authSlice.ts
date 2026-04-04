import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { User } from '@/types'

interface AuthState {
  user: Omit<User, 'created_at'> | null
  token: string | null
  loading: boolean
  error: string | null
}

const initialState: AuthState = {
  user: null,
  token: null,
  loading: false,
  error: null,
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials(state, action: PayloadAction<{ user: Omit<User, 'created_at'>; token: string }>) {
      state.user = action.payload.user
      state.token = action.payload.token
      state.error = null
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload
    },
    logout(state) {
      state.user = null
      state.token = null
      state.error = null
    },
  },
})

export const { setCredentials, setLoading, setError, logout } = authSlice.actions
export default authSlice.reducer
