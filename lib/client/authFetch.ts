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
  const state = store.getState()
  const token = state.auth.token
  if (token) headers.set('Authorization', `Bearer ${token}`)

  // Personal layout preferences are writable even for read-only project members.
  const method = (init.method ?? 'GET').toUpperCase()
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
  const isLayoutSave = method === 'PUT' && /^\/api\/projects\/[\da-f-]+\/view-preferences$/i.test(path)
  if (isWrite && !isLayoutSave && state.auth.user?.role === 'view') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }

  return fetch(input, { credentials: 'include', ...init, headers })
}
