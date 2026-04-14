'use client'

import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'

const projectQueues = new Map<string, Promise<unknown>>()

function enqueueByProject<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const prev = projectQueues.get(projectId) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(run)
  projectQueues.set(projectId, next)
  return next.finally(() => {
    if (projectQueues.get(projectId) === next) {
      projectQueues.delete(projectId)
    }
  })
}

export function enqueueTaskPut(projectId: string, payload: unknown): Promise<Response> {
  return enqueueByProject(projectId, () =>
    authFetch(`/api/tasks/${projectId}`, {
      method: 'PUT',
      headers: authFetchHeaders(true),
      body: JSON.stringify(payload),
    })
  )
}

