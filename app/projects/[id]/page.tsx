'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setTasks, clearTasks } from '@/store/slices/tasksSlice'
import { setCurrentProject } from '@/store/slices/projectSlice'
import { setProjectLines, clearProjectLines } from '@/store/slices/projectLinesSlice'
import GanttToolbar from '@/components/GanttChart/GanttToolbar'
import AIChatPanel from '@/components/GanttChart/AIChatPanel'
import ProjectLinesPanel from '@/components/GanttChart/ProjectLinesPanel'
import Link from 'next/link'
import { authFetch } from '@/lib/client/authFetch'
import { computeProjectProgressPercent } from '@/lib/projectProgress'
import { DEFAULT_VISIBLE_COLS, OPTIONAL_COL_META, DEFAULT_INDICATORS, type OptionalCol, type IndicatorsConfig } from '@/components/GanttChart/GanttChart'

const GanttChart = dynamic(() => import('@/components/GanttChart/GanttChart'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-64 text-gray-500">
      Loading Gantt Chart...
    </div>
  ),
})

const COL_W_MAX  = 56
const ZOOM_LEVELS = [3, 5, 7, 14, 21, 28, 35, 42, 49, 56]

export default function ProjectPage() {
  const params    = useParams()
  const projectId = params.id as string
  const dispatch  = useAppDispatch()
  const router    = useRouter()
  const { user, token }    = useAppSelector(s => s.auth)
  const isViewOnly = user?.role === 'view'
  const { currentProject } = useAppSelector(s => s.project)
  const { tasks, dirtyIds } = useAppSelector(s => s.tasks)
  const projectProgressPct = useMemo(() => computeProjectProgressPercent(tasks, currentProject?.status_date), [tasks, currentProject?.status_date])
  // ── Gantt UI state ─────────────────────────────────────────────────────
  const [colW,              setColW]              = useState(28)
  const [searchQuery,       setSearchQuery]       = useState('')
  const [expandAllSignal,   setExpandAllSignal]   = useState(0)
  const [collapseAllSignal, setCollapseAllSignal] = useState(0)
  const [focusSignal,       setFocusSignal]       = useState(0)
  const [showAI,            setShowAI]            = useState(false)
  const [showCriticalPath,  setShowCriticalPath]  = useState(false)
  const [showProjectLines,  setShowProjectLines]  = useState(false)
  const [showComparison,    setShowComparison]    = useState(false)
  const [compareLock,       setCompareLock]       = useState(false)
  const [pendingAIMessage,  setPendingAIMessage]  = useState<string | null>(null)
  const [visibleCols, setVisibleCols] = useState<OptionalCol[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLS
    try {
      const saved = localStorage.getItem(`gantt-cols-${projectId}`)
      if (saved) {
        const parsed = JSON.parse(saved) as OptionalCol[]
        const validKeys = new Set(OPTIONAL_COL_META.map(c => c.key))
        const filtered = Array.isArray(parsed) ? parsed.filter(k => validKeys.has(k)) : []
        if (filtered.length > 0) return filtered
      }
    } catch { /* ignore */ }
    return DEFAULT_VISIBLE_COLS
  })
  const handleVisibleColsChange = useCallback((cols: OptionalCol[]) => {
    setVisibleCols(cols)
    try { localStorage.setItem(`gantt-cols-${projectId}`, JSON.stringify(cols)) } catch { /* ignore */ }
  }, [projectId])

  const [indicators, setIndicators] = useState<IndicatorsConfig>(() => {
    if (typeof window === 'undefined') return DEFAULT_INDICATORS
    try {
      const saved = localStorage.getItem(`gantt-indicators-${projectId}`)
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<IndicatorsConfig>
        return { ...DEFAULT_INDICATORS, ...parsed }
      }
    } catch { /* ignore */ }
    return DEFAULT_INDICATORS
  })
  const handleIndicatorsChange = useCallback((next: IndicatorsConfig) => {
    setIndicators(next)
    try { localStorage.setItem(`gantt-indicators-${projectId}`, JSON.stringify(next)) } catch { /* ignore */ }
  }, [projectId])

  useEffect(() => {
    if (!user) { router.push('/login'); return }

    dispatch(setCurrentProject(null))
    dispatch(clearTasks())
    dispatch(clearProjectLines())

    let cancelled = false
    void (async () => {
      try {
        const [pr, tr, plr] = await Promise.all([
          authFetch(`/api/projects/${projectId}`).then(r => r.json()),
          authFetch(`/api/tasks/${projectId}`).then(r => r.json()),
          authFetch(`/api/project-lines/${projectId}`).then(r => r.json()),
        ])
        if (cancelled) return
        if (!pr.ok) {
          router.push('/dashboard')
          return
        }
        dispatch(setCurrentProject(pr.value))
        if (tr.ok && tr.value) {
          dispatch(
            setTasks({
              tasks: Array.isArray(tr.value.tasks) ? tr.value.tasks : [],
              dependencies: Array.isArray(tr.value.dependencies) ? tr.value.dependencies : [],
            })
          )
        }
        if (plr.ok && Array.isArray(plr.value)) {
          dispatch(setProjectLines(plr.value))
        }
      } catch {
        if (!cancelled) router.push('/dashboard')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user, projectId, token, dispatch, router])

  // ── 未保存提醒 ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyIds.length > 0) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirtyIds])

  if (!user) return null

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回项目列表
        </Link>
        <h1 className="text-lg font-semibold text-gray-900">
          {currentProject?.name ?? '加载中...'}
          {currentProject?.name != null && (
            <span className="text-blue-600 font-semibold tabular-nums">
              （{projectProgressPct}%）
            </span>
          )}
        </h1>
      </header>

      <GanttToolbar
        projectId={projectId}
        readOnly={isViewOnly}
        colW={colW}
        onZoomIn={() => setColW(w => {
          const idx = ZOOM_LEVELS.indexOf(w)
          return idx < 0 ? Math.min(COL_W_MAX, w + 7) : ZOOM_LEVELS[Math.min(idx + 1, ZOOM_LEVELS.length - 1)]
        })}
        onZoomOut={() => setColW(w => {
          const idx = ZOOM_LEVELS.indexOf(w)
          return idx < 0 ? Math.max(ZOOM_LEVELS[0], w - 7) : ZOOM_LEVELS[Math.max(idx - 1, 0)]
        })}
        onExpandAll={() => setExpandAllSignal(n => n + 1)}
        onCollapseAll={() => setCollapseAllSignal(n => n + 1)}
        onFocusTask={() => setFocusSignal(n => n + 1)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onToggleAI={() => setShowAI(v => !v)}
        onAutoAI={(msg: string) => { setShowAI(true); setPendingAIMessage(msg) }}
        showCriticalPath={showCriticalPath}
        onToggleCriticalPath={() => setShowCriticalPath(v => !v)}
        onToggleProjectLines={() => setShowProjectLines(v => !v)}
        showComparison={showComparison}
        onToggleComparison={() => setShowComparison(v => !v)}
        onShowComparison={() => setShowComparison(true)}
        compareLock={compareLock}
        onToggleCompareLock={(next) => { setCompareLock(next); setShowComparison(next) }}
        visibleCols={visibleCols}
        onVisibleColsChange={handleVisibleColsChange}
        indicators={indicators}
        onIndicatorsChange={handleIndicatorsChange}
      />

      {showProjectLines && (
        <ProjectLinesPanel projectId={projectId} onClose={() => setShowProjectLines(false)} />
      )}

      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-hidden">
          <GanttChart
            projectId={projectId}
            statusDate={currentProject?.status_date}
            colW={colW}
            searchQuery={searchQuery}
            expandAllSignal={expandAllSignal}
            collapseAllSignal={collapseAllSignal}
            focusSignal={focusSignal}
            showCriticalPath={showCriticalPath}
            visibleCols={visibleCols}
            indicators={indicators}
            readOnly={compareLock}
            showComparison={showComparison}
          />
        </div>
        {showAI && (
          <AIChatPanel
            projectId={projectId}
            onClose={() => setShowAI(false)}
            autoMessage={pendingAIMessage}
            onAutoMessageConsumed={() => setPendingAIMessage(null)}
          />
        )}
      </div>
    </div>
  )
}
