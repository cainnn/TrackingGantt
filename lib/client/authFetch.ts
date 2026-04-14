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

  // view 角色：本地可以体验编辑，但所有写操作不落库（返回空 OK 响应）
  const method = (init.method ?? 'GET').toUpperCase()
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  if (isWrite && state.auth.user?.role === 'view') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }

  return fetch(input, { credentials: 'include', ...init, headers })
}
