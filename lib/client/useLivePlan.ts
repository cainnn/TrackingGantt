'use client'

import { useEffect, useRef, useState } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '@/store'
import type { DraftSnapshot } from '@/store/draftHistory'
import type { SaveBaseline } from '../clientSave'
import { decidePlanSync } from '../planSync'
import { authFetch } from './authFetch'

export function useLivePlan(projectId: string, enabled: boolean, blocked: boolean, apply: (plan: SaveBaseline) => void) {
  const store = useStore<RootState>()
  const options = useRef({ blocked, apply })
  options.current = { blocked, apply }
  const [pending, setPending] = useState<SaveBaseline | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [updated, setUpdated] = useState(false)
  const checkRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    setPending(null); setError('')
    let closed = false, inFlight = false, pointerDown = false
    let cached: { plan: SaveBaseline; source: DraftSnapshot | null } | null = null
    let controller: AbortController | null = null
    const interacting = () => options.current.blocked || pointerDown || !!document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')
      || [...document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"], .fixed.inset-0, [data-plan-busy="true"]')].some(el => el.getClientRects().length > 0)
    const settle = () => {
      if (!cached || closed) return
      const decision = decidePlanSync(store.getState(), projectId, cached.source, cached.plan, interacting())
      if (decision === 'defer') { setPending(cached.plan); return }
      setPending(null)
      if (decision === 'apply') { options.current.apply(cached.plan); setUpdated(true) }
      if (decision === 'stale' || decision === 'apply') cached = null
    }
    const check = async () => {
      if (closed || inFlight || document.visibilityState === 'hidden') return
      settle()
      const state = store.getState()
      if (state.draft.saving || state.draft.projectId !== projectId || !state.draft.baseline) return
      const source = state.draft.baseline
      inFlight = true; setChecking(true)
      controller = new AbortController()
      const timeout = window.setTimeout(() => controller?.abort(), 15000)
      try {
        const response = await authFetch(`/api/tasks/${projectId}?save_state=1`, {
          cache: 'no-store', signal: controller.signal,
          headers: cached?.plan.revision ? { 'If-None-Match': `"${cached.plan.revision}"` } : {},
        })
        if (closed) return
        if (response.status !== 304) {
          const data = await response.json()
          if (!response.ok || !data.ok || !Array.isArray(data.value?.tasks) || !Array.isArray(data.value?.dependencies)
            || !Array.isArray(data.value?.lines) || !/^[a-f0-9]{64}$/.test(data.value?.revision ?? '')) throw new Error('无法获取更新')
          cached = { plan: data.value, source }
        }
        if (closed) return
        setError(''); settle()
      } catch {
        if (!closed) setError('同步暂时中断，当前内容已保留；可重试，网络恢复后会自动检查。')
      } finally {
        window.clearTimeout(timeout); inFlight = false
        if (!closed) setChecking(false)
      }
    }
    const refresh = () => { void check() }
    const down = () => { pointerDown = true }
    const up = () => { pointerDown = false }
    const blur = () => { pointerDown = false }
    checkRef.current = refresh
    const interval = window.setInterval(refresh, 10000)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', refresh)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('mousedown', down, true)
    document.addEventListener('mouseup', up, true)
    refresh()
    return () => {
      closed = true; controller?.abort(); window.clearInterval(interval); checkRef.current = () => {}
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', refresh)
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('mousedown', down, true); document.removeEventListener('mouseup', up, true)
    }
  }, [projectId, enabled, store])
  return { pending, error, checking, updated, check: () => checkRef.current() }
}
