'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setTasks, clearTasks } from '@/store/slices/tasksSlice'
import { setCurrentProject } from '@/store/slices/projectSlice'
import GanttToolbar from '@/components/GanttChart/GanttToolbar'
import VersionPanel from '@/components/GanttChart/VersionPanel'
import Link from 'next/link'

const GanttChart = dynamic(() => import('@/components/GanttChart/GanttChart'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-64 text-gray-500">
      Loading Gantt Chart...
    </div>
  ),
})

const COL_W_MIN  = 14
const COL_W_MAX  = 56
const COL_W_STEP = 7

export default function ProjectPage() {
  const params    = useParams()
  const projectId = params.id as string
  const dispatch  = useAppDispatch()
  const router    = useRouter()
  const { user }           = useAppSelector(s => s.auth)
  const { currentProject } = useAppSelector(s => s.project)
  const loadedRef = useRef(false)

  // ── Gantt UI state ─────────────────────────────────────────────────────
  const [colW,              setColW]              = useState(28)
  const [searchQuery,       setSearchQuery]       = useState('')
  const [expandAllSignal,   setExpandAllSignal]   = useState(0)
  const [collapseAllSignal, setCollapseAllSignal] = useState(0)
  const [focusSignal,       setFocusSignal]       = useState(0)
  const [showVersions,      setShowVersions]      = useState(false)

  useEffect(() => {
    if (!user) { router.push('/login'); return }
    if (loadedRef.current) return
    loadedRef.current = true

    fetch(`/api/projects/${projectId}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) dispatch(setCurrentProject(data.value))
        else router.push('/dashboard')
      })
      .catch(() => router.push('/dashboard'))

    fetch(`/api/tasks/${projectId}`)
      .then(r => r.json())
      .then(data => { if (data.ok) dispatch(setTasks(data.value)) })
      .catch(() => {})

    return () => {
      dispatch(clearTasks())
      dispatch(setCurrentProject(null))
    }
  }, [user, projectId, dispatch, router])

  if (!user) return null

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回项目列表
        </Link>
        <h1 className="text-lg font-semibold text-gray-900">
          {currentProject?.name ?? '加载中...'}
        </h1>
      </header>

      <GanttToolbar
        projectId={projectId}
        colW={colW}
        onZoomIn={() => setColW(w => Math.min(COL_W_MAX, w + COL_W_STEP))}
        onZoomOut={() => setColW(w => Math.max(COL_W_MIN, w - COL_W_STEP))}
        onExpandAll={() => setExpandAllSignal(n => n + 1)}
        onCollapseAll={() => setCollapseAllSignal(n => n + 1)}
        onFocusTask={() => setFocusSignal(n => n + 1)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onShowVersions={() => setShowVersions(true)}
      />

      {showVersions && (
        <VersionPanel projectId={projectId} onClose={() => setShowVersions(false)} />
      )}

      <div className="flex-1 overflow-hidden">
        <GanttChart
          projectId={projectId}
          statusDate={currentProject?.status_date}
          colW={colW}
          searchQuery={searchQuery}
          expandAllSignal={expandAllSignal}
          collapseAllSignal={collapseAllSignal}
          focusSignal={focusSignal}
        />
      </div>
    </div>
  )
}
