'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initializeDraft, resetDraft, hasDraftChanges, beginDraftSave, failDraftSave } from '@/store/draftHistory'
import { setTasks, clearTasks, clearViewSnapshot, markDirty } from '@/store/slices/tasksSlice'
import { applyAutoStartAnchor, runFullCascade } from '@/lib/clientScheduling'
import { toDateTimeStr } from '@/lib/clientTime'
import type { SaveBaseline } from '@/lib/clientSave'
import { normalizePlanningStatus } from '@/lib/planningStatus'
import type { Task } from '@/types'
import { setCurrentProject } from '@/store/slices/projectSlice'
import { setVersions } from '@/store/slices/versionsSlice'
import { setProjectLines, clearProjectLines } from '@/store/slices/projectLinesSlice'
import GanttToolbar from '@/components/GanttChart/GanttToolbar'
import AIChatPanel from '@/components/GanttChart/AIChatPanel'
import ProjectLinesPanel from '@/components/GanttChart/ProjectLinesPanel'
import SavedViewsMenu from '@/components/GanttChart/SavedViewsMenu'
import type { ChartViewState } from '@/lib/clientViewState'
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

// colW = 像素 / 天。分钟项目可缩小查看全局，编辑和吸附仍保留分钟精度。
const ZOOM_LEVELS_DAY    = [3, 5, 7, 14, 21, 28, 35, 42, 49, 56]
const ZOOM_LEVELS_MINUTE = [24, 60, 120, 240, 480, 720, 1440, 2880]

export default function ProjectPage() {
  const params    = useParams()
  const projectId = params.id as string
  const dispatch  = useAppDispatch()
  const router    = useRouter()
  const { user, token }    = useAppSelector(s => s.auth)
  const { currentProject } = useAppSelector(s => s.project)
  const { versions } = useAppSelector(s => s.versions)
  const draftChanged = useAppSelector(hasDraftChanges)
  const draftHistory = useAppSelector(s => s.draft)
  const [restoreReview, setRestoreReview] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [baselineRevision, setBaselineRevision] = useState(0)
  const { tasks, viewSnapshot } = useAppSelector(s => s.tasks)
  // 浏览历史版本时强制只读，防止误操作
  const isViewOnly = user?.role === 'view' || !!viewSnapshot
  // 浏览历史版本时，状态日期跟随被浏览版本（影响延期检测、当前线、进度计算）
  const effectiveStatusDate = useMemo(() => {
    if (!viewSnapshot) return toDateTimeStr(currentProject?.status_date ?? null)
    const v = versions.find(x => x.id === viewSnapshot.versionId)
    return toDateTimeStr(v?.status_date ?? currentProject?.status_date ?? null)
  }, [viewSnapshot, versions, currentProject?.status_date])
  const [previewStatusDate, setPreviewStatusDate] = useState<string | null>(null)
  const [discardSignal, setDiscardSignal] = useState(0)
  const [loadedBaseline, setLoadedBaseline] = useState<(SaveBaseline & { projectId: string }) | null>(null)
  const progressStatusDate = previewStatusDate ?? effectiveStatusDate
  const projectProgressPct = useMemo(() => computeProjectProgressPercent(tasks, progressStatusDate), [tasks, progressStatusDate])
  // 项目精度（创建时固定）
  const isMinute = currentProject?.time_granularity === 'minute'
  const zoomLevels = isMinute ? ZOOM_LEVELS_MINUTE : ZOOM_LEVELS_DAY
  const zoomMax = zoomLevels[zoomLevels.length - 1]
  // ── Gantt UI state ─────────────────────────────────────────────────────
  const [colW,              setColW]              = useState(28)
  // 分钟级项目首次加载时把默认列宽提到 1440（1px/分钟），
  // 用户继续放大到 2880（2px/分钟）。
  const colWInitRef = useRef(false)
  useEffect(() => {
    if (colWInitRef.current) return
    if (currentProject?.time_granularity === 'minute' && colW === 28) {
      setColW(1440)
    }
    if (currentProject) colWInitRef.current = true
  }, [currentProject, colW])
  const [searchQuery,       setSearchQuery]       = useState('')
  const [expandAllSignal,   setExpandAllSignal]   = useState(0)
  const [collapseAllSignal, setCollapseAllSignal] = useState(0)
  const chartCapture = useRef<(() => ChartViewState) | null>(null)
  const [viewRestore, setViewRestore] = useState<{ state: ChartViewState; id: number } | undefined>()
  const [timelineRequest, setTimelineRequest] = useState<{ kind: 'all' | 'selection' | 'status'; id: number } | undefined>()
  const [focusSignal,       setFocusSignal]       = useState(0)
  const [showAI,            setShowAI]            = useState(false)
  const [showCriticalPath,  setShowCriticalPath]  = useState(false)
  const [showProjectLines,  setShowProjectLines]  = useState(false)
  const [showComparison,    setShowComparison]    = useState(false)
  const [pendingAIMessage,  setPendingAIMessage]  = useState<string | null>(null)
  const [visibleCols, setVisibleCols] = useState<OptionalCol[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLS
    try {
      const saved = localStorage.getItem(`gantt-cols-v2-${projectId}`)
      if (saved) {
        const parsed = JSON.parse(saved) as OptionalCol[]
        const validKeys = new Set(OPTIONAL_COL_META.map(c => c.key))
        const filtered = Array.isArray(parsed) ? parsed.filter(k => validKeys.has(k)) : []
        if (filtered.length > 0) {
          if (!filtered.includes('taskType')) {
            const idx = filtered.includes('ctype')
              ? filtered.indexOf('ctype')
              : (filtered.includes('lag') ? filtered.indexOf('lag') + 1 : filtered.length)
            return [...filtered.slice(0, idx), 'taskType', ...filtered.slice(idx)]
          }
          return filtered
        }
      }
    } catch { /* ignore */ }
    return DEFAULT_VISIBLE_COLS
  })
  const handleVisibleColsChange = useCallback((cols: OptionalCol[]) => {
    setVisibleCols(cols)
    try { localStorage.setItem(`gantt-cols-v2-${projectId}`, JSON.stringify(cols)) } catch { /* ignore */ }
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

  const handleRestoreViewedSnapshot = useCallback(async () => {
    if (!viewSnapshot) return
    if (!restoreReview || restoring || draftChanged) return
    setRestoring(true)
    dispatch(beginDraftSave())
    try {
      const restoreRes = await authFetch(`/api/versions/${projectId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: viewSnapshot.versionId }),
      })
      const restoreData = await restoreRes.json()
      if (!restoreRes.ok || !restoreData.ok) {
        throw new Error(restoreData.error ?? `恢复失败 (${restoreRes.status})`)
      }

      const [projectData, taskData, versionsData, linesData] = await Promise.all([
        authFetch(`/api/projects/${projectId}`).then(r => r.json()),
        authFetch(`/api/tasks/${projectId}`).then(r => r.json()),
        authFetch(`/api/versions/${projectId}?list=1`).then(r => r.json()),
        authFetch(`/api/project-lines/${projectId}`).then(r => r.json()),
      ])
      if (!projectData.ok || !taskData.ok || !versionsData.ok || !linesData.ok) throw new Error('恢复已提交，但重新加载失败，请刷新核对')
      const baseline = {
        tasks: taskData.value.tasks, dependencies: taskData.value.dependencies,
        statusDate: toDateTimeStr(projectData.value.status_date), planningStatus: normalizePlanningStatus(projectData.value.planning_status), lines: linesData.value,
      }
      dispatch(setCurrentProject(projectData.value))
      dispatch(resetDraft({ ...baseline, descriptions: {} }))
      dispatch(clearViewSnapshot())
      dispatch(setVersions(versionsData.value))
      setLoadedBaseline({ ...baseline, projectId })
      setBaselineRevision(n => n + 1)
      setRestoreReview(false)
    } catch (err) {
      dispatch(failDraftSave())
      alert(`恢复失败：${err instanceof Error ? err.message : String(err)}。请重新加载核对后台状态。`)
    } finally { setRestoring(false) }
  }, [dispatch, projectId, viewSnapshot, restoreReview, restoring, draftChanged])

  useEffect(() => {
    if (!user) { router.push('/login'); return }

    dispatch(setCurrentProject(null))
    dispatch(clearTasks())
    dispatch(clearProjectLines())
    setLoadedBaseline(null)

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
        if (!tr.ok || !tr.value || !plr.ok || !Array.isArray(plr.value)) throw new Error(tr.error ?? '加载项目数据失败')
        dispatch(setCurrentProject(pr.value))
        if (tr.ok && tr.value) {
          let loadedTasks: Task[] = Array.isArray(tr.value.tasks) ? tr.value.tasks : []
          const loadedDeps = Array.isArray(tr.value.dependencies) ? tr.value.dependencies : []
          // 自动起点锚定：无依赖 + auto_schedule 的任务起点不早于
          //   max(项目开始时间, 当前时间)。
          // 天级项目把锚点对齐到当天 00:00，避免任务带 sub-day 时间。
          //
          // 已设 status_date 的项目视为"用户在主动推进"，跳过 anchor，
          // 避免历史/示例项目被强行拉到今天造成假延期。
          const projIsMinute = pr.value?.time_granularity === 'minute'
          const hasStatusDate = !!pr.value?.status_date
          const now = new Date()
          const pad = (n: number) => String(n).padStart(2, '0')
          const nowStr = projIsMinute
            ? `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`
            : `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T00:00:00`
          const projStartRaw = toDateTimeStr(pr.value?.start_date ?? null)
          const projStart = !projIsMinute && projStartRaw
            ? `${projStartRaw.slice(0, 10)}T00:00:00`
            : projStartRaw
          const earliest = projStart && projStart > nowStr ? projStart : nowStr
          const anchored = hasStatusDate
            ? []
            : applyAutoStartAnchor(loadedTasks, loadedDeps, earliest)
          let dirtyIds: string[] = []
          if (anchored.length > 0) {
            const byId = new Map(anchored.map(t => [t.id, t]))
            loadedTasks = loadedTasks.map(t => byId.get(t.id) ?? t)
            dirtyIds = anchored.map(t => t.id)
            // 再跑一次级联，让下游跟着前移
            const cascaded = runFullCascade(loadedTasks, loadedDeps, { isMinute: projIsMinute })
            if (cascaded.length > 0) {
              const cByid = new Map(cascaded.map(t => [t.id, t]))
              loadedTasks = loadedTasks.map(t => cByid.get(t.id) ?? t)
              dirtyIds = [...new Set([...dirtyIds, ...cascaded.map(t => t.id)])]
            }
          }
          dispatch(setTasks({ tasks: loadedTasks, dependencies: loadedDeps }))
          if (dirtyIds.length > 0) dispatch(markDirty(dirtyIds))
          setLoadedBaseline({
            projectId,
            tasks: tr.value.tasks,
            dependencies: loadedDeps,
            planningStatus: normalizePlanningStatus(pr.value.planning_status),
            statusDate: toDateTimeStr(pr.value.status_date ?? null), lines: plr.value,
          })
        }
        if (plr.ok && Array.isArray(plr.value)) {
          dispatch(setProjectLines(plr.value))
          dispatch(initializeDraft({ projectId, baseline: {
            tasks: tr.value.tasks, dependencies: tr.value.dependencies,
            planningStatus: normalizePlanningStatus(pr.value.planning_status),
            statusDate: toDateTimeStr(pr.value.status_date ?? null), lines: plr.value, descriptions: {},
          } }))
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
      if (draftChanged || draftHistory.uncertain || draftHistory.saving) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [draftChanged, draftHistory.uncertain, draftHistory.saving])

  const handleCaptureReady = useCallback((capture: (() => ChartViewState) | null) => { chartCapture.current = capture }, [])

  if (!user) return null

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link href="/dashboard" onClick={e => {
          if ((draftChanged || draftHistory.uncertain || draftHistory.saving) && !confirm('有未保存的草稿或待核对的保存结果，离开后草稿将丢失。确认离开？')) e.preventDefault()
        }} className="text-sm text-gray-500 hover:text-gray-700">
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

      {viewSnapshot && (
        <div className="flex items-center justify-between px-4 py-2 bg-amber-50 border-b border-amber-200 text-[13px] text-amber-800">
          <span className="flex items-center gap-2">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3l2 1" />
            </svg>
            正在查看历史版本「<span className="font-semibold">{viewSnapshot.versionName}</span>」（只读，不影响当前工作状态）
          </span>
          <div className="flex items-center gap-2">
            {user?.role !== 'view' && (
              <button
                onClick={() => setRestoreReview(true)}
                disabled={draftChanged || draftHistory.saving || draftHistory.uncertain}
                title={draftChanged ? "请先保存或放弃当前草稿" : "预览恢复影响，再确认更改"}
                className="px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
              >
                恢复预览
              </button>
            )}
            <button
              onClick={() => dispatch(clearViewSnapshot())}
              className="px-3 py-1 rounded border border-amber-400 text-amber-700 hover:bg-amber-100 cursor-pointer"
            >
              退出查看
            </button>
          </div>
        </div>
      )}

      {restoreReview && viewSnapshot && <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="恢复历史版本确认">
        <div className="bg-white rounded-lg p-6 w-[480px] space-y-4">
          <h2 className="font-semibold">恢复历史版本：{viewSnapshot.versionName}</h2>
          <p className="text-sm">当前 {tasks.filter(t => !t.is_deleted).length} 个任务将恢复为 {viewSnapshot.tasks.filter(t => !t.is_deleted).length} 个任务。状态日期也将恢复。</p>
          <p className="text-sm text-amber-800">确认后会写入数据库，并按现有规则删除该版本之后的版本。此操作不属于前端逐步撤销。</p>
          <div className="flex justify-end gap-3">
            <button disabled={restoring} onClick={() => setRestoreReview(false)}>取消</button>
            <button disabled={restoring || draftChanged} className="rounded bg-amber-600 text-white px-3 py-2" onClick={handleRestoreViewedSnapshot}>{restoring ? '恢复中…' : '确认更改并恢复'}</button>
          </div>
        </div>
      </div>}
      {loadedBaseline?.projectId === projectId && currentProject?.id === projectId && <GanttToolbar
        key={`${projectId}-${baselineRevision}`}
        initialBaseline={loadedBaseline}
        projectId={projectId}
        readOnly={isViewOnly}
        isMinute={isMinute}
        colW={colW}
        onZoomIn={() => setColW(w => {
          const idx = zoomLevels.indexOf(w)
          return idx < 0 ? (zoomLevels.find(x => x > w) ?? zoomMax) : zoomLevels[Math.min(idx + 1, zoomLevels.length - 1)]
        })}
        onZoomOut={() => setColW(w => {
          const idx = zoomLevels.indexOf(w)
          return idx < 0 ? ([...zoomLevels].reverse().find(x => x < w) ?? zoomLevels[0]) : zoomLevels[Math.max(idx - 1, 0)]
        })}
        onExpandAll={() => setExpandAllSignal(n => n + 1)}
        onCollapseAll={() => setCollapseAllSignal(n => n + 1)}
        onFocusTask={() => setFocusSignal(n => n + 1)}
        onTimelineNavigate={kind => setTimelineRequest(prev => ({ kind, id: (prev?.id ?? 0) + 1 }))}
        viewControls={<SavedViewsMenu projectId={projectId} capture={() => {
          const chart = chartCapture.current?.()
          return chart ? { search: searchQuery, columns: visibleCols, indicators, colW, critical: showCriticalPath, chart } : null
        }} apply={view => {
          setSearchQuery(view.search)
          handleVisibleColsChange(view.columns.filter(c => OPTIONAL_COL_META.some(m => m.key === c)) as OptionalCol[])
          handleIndicatorsChange(view.indicators)
          setColW(Math.max(0.1, Math.min(zoomMax, view.colW)))
          setShowCriticalPath(view.critical)
          setViewRestore(prev => ({ state: view.chart, id: (prev?.id ?? 0) + 1 }))
        }} />}
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
        visibleCols={visibleCols}
        onVisibleColsChange={handleVisibleColsChange}
        indicators={indicators}
        onIndicatorsChange={handleIndicatorsChange}
        onDiscardChanges={() => {
          setPreviewStatusDate(null)
          setDiscardSignal(n => n + 1)
        }}
      />}

      {showProjectLines && (
        <ProjectLinesPanel readOnly={isViewOnly} projectId={projectId} onClose={() => setShowProjectLines(false)} />
      )}

      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-hidden">
          <GanttChart
            projectId={projectId}
            isMinute={isMinute}
            statusDate={effectiveStatusDate}
            colW={colW}
            searchQuery={searchQuery}
            expandAllSignal={expandAllSignal}
            collapseAllSignal={collapseAllSignal}
            focusSignal={focusSignal}
            timelineRequest={timelineRequest}
            onColWChange={setColW}
            viewRestore={viewRestore}
            onCaptureReady={handleCaptureReady}
            showCriticalPath={showCriticalPath}
            visibleCols={visibleCols}
            onVisibleColsChange={handleVisibleColsChange}
            indicators={indicators}
            readOnly={isViewOnly}
            showComparison={showComparison}
            onStatusDatePreviewChange={setPreviewStatusDate}
            discardSignal={discardSignal}
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
