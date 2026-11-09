'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch } from './authFetch'
import { normalizeProjectViewPreferences, readSavedViews, type ProjectViewPreferences, type SavedGanttView } from '../clientViewState'

export function useProjectViews(projectId: string, enabled: boolean, restore: (view: SavedGanttView) => void) {
  const [preferences, setPreferences] = useState<ProjectViewPreferences | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadSignal, setLoadSignal] = useState(0)
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  const savingRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    setError(''); setNotice('')
    void (async () => {
      try {
        const response = await authFetch(`/api/projects/${projectId}/view-preferences`)
        const data = await response.json()
        const value = data.ok ? normalizeProjectViewPreferences(data.value) : null
        if (!response.ok || !value) throw new Error(data.error ?? '加载项目布局失败，请重试')
        if (cancelled) return
        // Keep existing browser layouts available; the next explicit save migrates them.
        if (value.revision === 0 && !data.value.readOnly) {
          try { value.views = readSavedViews(localStorage.getItem(`gantt-saved-views-v1-${projectId}`)) } catch { /* storage may be disabled */ }
        }
        setPreferences(value)
        setReadOnly(!!data.value.readOnly)
        if (value.currentView) restoreRef.current(value.currentView)
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : '加载项目布局失败，请重试')
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [projectId, enabled, loadSignal])

  const persist = useCallback(async (next: ProjectViewPreferences): Promise<boolean> => {
    if (savingRef.current || loading || readOnly || !preferences) return false
    savingRef.current = true
    setSaving(true); setError(''); setNotice('')
    try {
      const response = await authFetch(`/api/projects/${projectId}/view-preferences`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
      const data = await response.json()
      const value = data.ok ? normalizeProjectViewPreferences(data.value) : null
      if (!response.ok || !value) throw new Error(data.error ?? '保存项目布局失败，请重试')
      setPreferences(value)
      setNotice('布局已保存，重新打开此项目时会自动恢复')
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存项目布局失败，请重试')
      return false
    } finally { savingRef.current = false; setSaving(false) }
  }, [projectId, loading, readOnly, preferences])

  return { preferences, loading, saving, readOnly, error, notice, persist, reload: () => setLoadSignal(n => n + 1) }
}
