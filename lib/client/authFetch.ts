'use client'

import { store } from '@/store'

/** Prefer httpOnly cookie; add Bearer when Redux still holds token (same-tab SPA). */
export function authFetchHeaders(contentTypeJson?: boolean): Headers {
  const h = new Headers()
  if (contentTypeJson) h.set('Content-Type', 'application/json')
  const token = store.getState().auth.token
  if (token) h.set('Authorization', `Bearer ${token}`)
  return h
}

export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = store.getState().auth.token
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { credentials: 'include', ...init, headers })
}
