'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  copyTasks, addTasks, deleteTasks, updateTasks, addDependency, removeDependency,
  setSelectedIds, setTasks,
  markDirty, clearDirty, setComparison, clearComparison, setViewSnapshot, clearViewSnapshot, clearDiffFilter,
} from '@/store/slices/tasksSlice'
import { setStatusDate } from '@/store/slices/projectSlice'
import { setVersions } from '@/store/slices/versionsSlice'
import type { Task } from '@/types'
import EditTaskModal from './EditTaskModal'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { exportToExcel } from '@/lib/client/excelExport'
import { exportToJpeg, exportToPdf } from '@/lib/client/chartExport'
import { parseExcelFile, validateImportData, type ImportTask } from '@/lib/client/excelImport'
import { setProjectLines } from '@/store/slices/projectLinesSlice'
import { OPTIONAL_COL_META, type OptionalCol, INDICATOR_META, type IndicatorsConfig } from './GanttChart'
import VersionPanel from './VersionPanel'
import RetroLogPanel from './RetroLogPanel'
import { diffSnapshots, type SnapshotTask, type DiffItem } from '@/lib/versionDiff'

// ── Flat tree order ───────────────────────────────────────────────────────
function getFlatOrder(tasks: Task[]): Task[] {
  const kids: Record<string, Task[]> = {}
  tasks.forEach(t => {
    const k = t.parent_id ?? '__root__'
    if (!kids[k]) kids[k] = []
    kids[k].push(t)
  })
  const result: Task[] = []
  function walk(pid: string | null) {
    ;(kids[pid ?? '__root__'] ?? [])
      .sort((a, b) => a.order_index - b.order_index)
      .forEach(t => { result.push(t); walk(t.id) })
  }
  walk(null)
  return result
}

function calcPercent(task: Task, statusDate: Date): number {
  if (!task.start_date || !task.end_date) return task.percent_done
  const start = new Date(task.start_date)
  const end   = new Date(task.end_date)
  if (statusDate <= start) return 0
  if (statusDate >= end)   return 100
  return Math.round((statusDate.getTime() - start.getTime()) / (end.getTime() - start.getTime()) * 100)
}

// ── Icon components ───────────────────────────────────────────────────────
const Ic = ({ children, title, onClick, disabled, active, variant = 'default' }: {
  children: React.ReactNode
  title?: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  variant?: 'default' | 'green' | 'blue'
}) => {
  const base = 'inline-flex items-center justify-center rounded border text-[13px] font-medium transition-colors select-none'
  const size = 'w-8 h-8'
  const colors = {
    default: disabled ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-white'
           : active   ? 'border-blue-400 bg-blue-50 text-blue-600'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400 cursor-pointer bg-white',
    green:   'border-green-400 text-green-600 hover:bg-green-50 cursor-pointer bg-white',
    blue:    disabled ? 'border-blue-200 text-blue-300 cursor-not-allowed bg-white'
                     : 'border-blue-400 text-blue-600 hover:bg-blue-50 cursor-pointer bg-white',
  }
  return (
    <button className={`${base} ${size} ${colors[variant]}`}
            title={title} onClick={!disabled ? onClick : undefined} disabled={disabled}>
      {children}
    </button>
  )
}

// ── Labeled icon button (for CREATE / EDIT) ───────────────────────────────
const LabelIc = ({ icon, label, onClick, disabled, variant = 'default' }: {
  icon: React.ReactNode; label: string
  onClick?: () => void; disabled?: boolean
  variant?: 'green' | 'blue' | 'default'
}) => {
  const base = 'inline-flex items-center gap-1.5 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors select-none'
  const colors = {
    green:   'border-green-400 text-green-600 hover:bg-green-50 bg-white',
    blue:    disabled ? 'border-blue-200 text-blue-300 cursor-not-allowed bg-white'
                      : 'border-blue-400 text-blue-600 hover:bg-blue-50 bg-white cursor-pointer',
    default: disabled ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-white'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50 bg-white cursor-pointer',
  }
  return (
    <button className={`${base} ${colors[variant]}`}
            onClick={!disabled ? onClick : undefined} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

// ── SVG icons ─────────────────────────────────────────────────────────────
const IcoPlus    = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10"/></svg>
const IcoPencil  = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 2l3 3-8 8H3v-3L11 2z"/></svg>
const IcoUndo    = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7V3l-2 2 2 2z" fill="currentColor"/><path d="M3 5a7 7 0 1 1 0 6" strokeLinecap="round"/></svg>
const IcoRedo    = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M13 7V3l2 2-2 2z" fill="currentColor"/><path d="M13 5a7 7 0 1 0 0 6" strokeLinecap="round"/></svg>
const IcoExpand  = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5l4 4 4-4M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoCollapse= () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11l4-4 4 4M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoZoomIn  = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3M6.5 5v3" strokeLinecap="round"/></svg>
const IcoZoomOut = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3" strokeLinecap="round"/></svg>
const IcoFocus   = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M1 5V2h3M12 2h3v3M1 11v3h3M12 14h3v-3M6 8h4M8 6v4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoPrev    = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoNext    = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoSearch  = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5" strokeLinecap="round"/></svg>
const IcoRefresh = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 8a6 6 0 0 0-10-4.5M2 8a6 6 0 0 1 10 4.5" strokeLinecap="round"/><path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoDownload = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoUpload   = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 10V2M5 5l3-3 3 3M3 12h10" strokeLinecap="round" strokeLinejoin="round"/></svg>

// 年-月-日顺序的日期输入：显示 YYYY-MM-DD，点击触发原生日历选择
function YmdDateInput({
  value, max, onChange,
}: {
  value: string
  max?: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const openPicker = () => {
    const el = ref.current
    if (!el) return
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return } catch { /* fall through to focus */ }
    }
    el.focus()
  }
  return (
    <div className="relative inline-flex items-center">
      <input
        readOnly
        type="text"
        value={value}
        placeholder="YYYY-MM-DD"
        onClick={openPicker}
        onFocus={openPicker}
        className="border border-gray-300 rounded pl-2 pr-7 h-8 text-[13px] w-[120px] bg-white cursor-pointer focus:outline-none focus:border-blue-400"
      />
      <svg viewBox="0 0 24 24" width="14" height="14"
           className="absolute right-2 pointer-events-none text-gray-500"
           fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
      <input
        ref={ref}
        type="date"
        value={value}
        max={max}
        onChange={onChange}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
      />
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────
interface GanttToolbarProps {
  projectId: string
  readOnly?: boolean
  colW: number
  onZoomIn: () => void
  onZoomOut: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onFocusTask: () => void
  searchQuery: string
  onSearchChange: (q: string) => void
  onToggleAI?: () => void
  onAutoAI?: (msg: string) => void
  showCriticalPath?: boolean
  onToggleCriticalPath?: () => void
  onToggleProjectLines?: () => void
  showComparison?: boolean
  onToggleComparison?: () => void
  onShowComparison?: () => void
  compareLock?: boolean
  onToggleCompareLock?: (next: boolean) => void
  visibleCols?: OptionalCol[]
  onVisibleColsChange?: (cols: OptionalCol[]) => void
  indicators?: IndicatorsConfig
  onIndicatorsChange?: (next: IndicatorsConfig) => void
}

export default function GanttToolbar({
  projectId,
  readOnly,
  colW, onZoomIn, onZoomOut,
  onExpandAll, onCollapseAll,
  onFocusTask,
  searchQuery, onSearchChange,
  onToggleAI,
  onAutoAI,
  showCriticalPath,
  onToggleCriticalPath,
  onToggleProjectLines,
  showComparison,
  onToggleComparison,
  onShowComparison,
  compareLock,
  onToggleCompareLock,
  visibleCols,
  onVisibleColsChange,
  indicators,
  onIndicatorsChange,
}: GanttToolbarProps) {
  const dispatch = useAppDispatch()
  const { selectedIds, clipboard, clipboardDeps, tasks, dependencies, dirtyIds, comparison, viewSnapshot, diffFilter } = useAppSelector(s => s.tasks)
  const currentProject = useAppSelector(s => s.project.currentProject)
  const { versions } = useAppSelector(s => s.versions)

  // 上一版本的状态日期（用于限制新版本必须严格大于旧版本）
  const lastVersionDate = React.useMemo(() => {
    if (!versions.length) return null
    const latest = versions[0]
    return latest.status_date?.split('T')[0] ?? null
  }, [versions])

  // 日期选择器的最小可选日期（上一版本日期+1天）
  const minSelectableDate = React.useMemo(() => {
    if (!lastVersionDate) return null
    const d = new Date(lastVersionDate)
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [lastVersionDate])

  // Column settings dropdown
  const [colSettingsOpen, setColSettingsOpen] = useState(false)
  const colSettingsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!colSettingsOpen) return
    const close = (e: MouseEvent) => {
      if (colSettingsRef.current && !colSettingsRef.current.contains(e.target as Node)) setColSettingsOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [colSettingsOpen])

  // Indicators dropdown
  const [indicatorsOpen, setIndicatorsOpen] = useState(false)
  const indicatorsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!indicatorsOpen) return
    const close = (e: MouseEvent) => {
      if (indicatorsRef.current && !indicatorsRef.current.contains(e.target as Node)) setIndicatorsOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [indicatorsOpen])

  const hasSelection = selectedIds.length > 0

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)
  const [retroLogOpen, setRetroLogOpen] = useState(false)

  // ── 变更检测（纯本地，不依赖 API）──────────────────────────────────
  // 基线：首次加载任务时捕获，不做任何 API 调用
  const [baseline, setBaseline] = useState<SnapshotTask[] | null>(null)

  // 任务首次加载完成时，捕获当前状态作为基线
  const baselineCapturedRef = useRef(false)
  useEffect(() => {
    if (baselineCapturedRef.current || tasks.length === 0) return
    baselineCapturedRef.current = true
    setBaseline(tasks.filter(t => !t.is_deleted).map(t => ({
      id: t.id, task_code: t.task_code, name: t.name,
      start_date: t.start_date, end_date: t.end_date,
      duration: t.duration, assignee: t.assignee,
      percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
      parent_id: t.parent_id,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length])

  // changeDiffs: 当前任务 vs 基线
  const changeDiffs = React.useMemo(() => {
    if (!baseline) return [] as DiffItem[]
    const currentSnap: SnapshotTask[] = tasks.filter(t => !t.is_deleted).map(t => ({
      id: t.id, task_code: t.task_code, name: t.name,
      start_date: t.start_date, end_date: t.end_date,
      duration: t.duration, assignee: t.assignee,
      percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
      parent_id: t.parent_id,
    }))
    return diffSnapshots(baseline, currentSnap)
  }, [baseline, tasks])

  const hasChanges = changeDiffs.length > 0

  // 变更审核弹窗状态
  const [reviewOpen, setReviewOpen] = useState(false)
  // 每个变更项的原因（key = task_code）
  const [reasons, setReasons] = useState<Record<string, string>>({})

  // 对比模式：进入时默认对比最近快照，目标可在历史版本面板切换
  const handleToggleCompareLock = useCallback(async () => {
    if (comparison) {
      dispatch(clearComparison())
      dispatch(clearViewSnapshot())
      onToggleCompareLock?.(false)
      return
    }
    if (!versions.length) {
      alert('还没有历史快照可供对比')
      return
    }
    const latest = versions[0]
    try {
      const r = await authFetch(`/api/versions/${projectId}?id=${latest.id}`)
      const d = await r.json()
      if (d.ok && d.value?.snapshot?.tasks) {
        dispatch(setComparison({
          tasks: d.value.snapshot.tasks,
          versionName: latest.name || latest.status_date?.split('T')[0] || `快照 #${latest.version_number}`,
        }))
        onShowComparison?.()
        onToggleCompareLock?.(true)
      }
    } catch { /* ignore */ }
  }, [comparison, versions, projectId, dispatch, onShowComparison, onToggleCompareLock])

  // 同步对比锁定与 comparison 状态：面板里选别的版本对比时，也触发编辑锁
  useEffect(() => {
    if (comparison && !compareLock) {
      onToggleCompareLock?.(true)
      onShowComparison?.()
    } else if (!comparison && compareLock) {
      onToggleCompareLock?.(false)
    }
  }, [comparison, compareLock, onToggleCompareLock, onShowComparison])
  // 区分主动/被动变更：
  // - 添加/删除 → 主动
  // - 仅顺序（order_index）变化 → 被动，自动填「由于 {主动项} 调整引发」
  // - 字段变更且该任务存在上游依赖（from→to 链中的 from 也在变更集里） → 被动，自动填「由 {前置 task_code} 调整引发」
  // - 其余字段变更 → 主动
  // - 特例：全部都是顺序变化 → 位移最大的那项视为主动
  const { primaryCodes, passiveReasonMap } = React.useMemo(() => {
    const idByCode = new Map<string, string>()
    const codeById = new Map<string, string>()
    for (const t of tasks) {
      idByCode.set(t.task_code, t.id)
      codeById.set(t.id, t.task_code)
    }

    const addedRemoved = new Set<string>()
    const fieldChangedCodes = new Set<string>()
    const orderOnly: { code: string; delta: number }[] = []
    for (const d of changeDiffs) {
      if (d.type !== 'changed') { addedRemoved.add(d.task_code); continue }
      const fields = (d.changes ?? []).map(c => c.field)
      const isOrderOnly = fields.length > 0 && fields.every(f => f === '顺序')
      if (isOrderOnly) {
        const c = d.changes![0]
        orderOnly.push({ code: d.task_code, delta: Math.abs((Number(c.new) || 0) - (Number(c.old) || 0)) })
      } else {
        fieldChangedCodes.add(d.task_code)
      }
    }

    // 依赖级联：沿依赖链向上追溯源头——只有无变更前置的节点才是主动
    // 例：1→2→3，1、2、3 都变了，2 和 3 的源头都追溯到 1
    const changedPredsOf = (code: string): string[] => {
      const id = idByCode.get(code)
      if (!id) return []
      return dependencies
        .filter(dep => dep.to_task_id === id)
        .map(dep => codeById.get(dep.from_task_id))
        .filter((c): c is string => !!c && fieldChangedCodes.has(c))
    }
    const cascadeReason: Record<string, string> = {}
    for (const code of fieldChangedCodes) {
      if (changedPredsOf(code).length === 0) continue // 本身是源头
      const roots = new Set<string>()
      const visited = new Set<string>()
      const stack = [code]
      while (stack.length) {
        const cur = stack.pop()!
        if (visited.has(cur)) continue
        visited.add(cur)
        const preds = changedPredsOf(cur)
        if (cur !== code && preds.length === 0) {
          roots.add(cur)
        } else {
          for (const p of preds) stack.push(p)
        }
      }
      if (roots.size > 0) {
        cascadeReason[code] = `由 ${Array.from(roots).join(', ')} 调整引发`
      }
    }

    const primary = new Set<string>()
    for (const c of addedRemoved) primary.add(c)
    for (const c of fieldChangedCodes) if (!cascadeReason[c]) primary.add(c)

    const passive: Record<string, string> = { ...cascadeReason }
    if (primary.size === 0 && orderOnly.length > 0) {
      orderOnly.sort((a, b) => b.delta - a.delta)
      primary.add(orderOnly[0].code)
      for (const { code } of orderOnly.slice(1)) passive[code] = `由于 ${orderOnly[0].code} 的调整引发`
    } else {
      const label = Array.from(primary).join(', ')
      for (const { code } of orderOnly) {
        if (!primary.has(code)) passive[code] = `由于 ${label} 的调整引发`
      }
    }
    return { primaryCodes: primary, passiveReasonMap: passive }
  }, [changeDiffs, tasks, dependencies])

  const openReview = useCallback(() => {
    setReasons({})
    setReviewOpen(true)
  }, [])
  const allReasonsFilled = changeDiffs.length > 0 &&
    changeDiffs.every(d => !primaryCodes.has(d.task_code) || (reasons[d.task_code] ?? '').trim().length > 0)

  // 初始加载时，拉取版本列表
  useEffect(() => {
    authFetch(`/api/versions/${projectId}?list=1`)
      .then(r => r.json())
      .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
      .catch(() => {})
  }, [projectId, dispatch])

  // 用户编辑产生变更后，自动加载最近版本快照并显示对比基线
  // 只要 hasChanges 为 true 且当前未显示对比，就补上；不再用 once-ref 锁死
  const comparisonShownRef = useRef(false)
  useEffect(() => {
    if (!hasChanges) { comparisonShownRef.current = false; return }
    if (comparison) return
    if (comparisonShownRef.current) return
    if (!baseline || baseline.length === 0) return
    comparisonShownRef.current = true
    // 直接用本地基线（进入项目时的状态）作为对比基线——与当前任务 id 完全匹配
    const byId = new Map(tasks.map(t => [t.id, t]))
    const snap = baseline.map(b => {
      const t = byId.get(b.id)
      if (!t) return null
      return {
        ...t,
        start_date: b.start_date,
        end_date: b.end_date,
        duration: b.duration,
        percent_done: b.percent_done,
        is_milestone: b.is_milestone,
        parent_id: b.parent_id,
      }
    }).filter((x): x is NonNullable<typeof x> => !!x)
    if (snap.length === 0) { comparisonShownRef.current = false; return }
    const versionName = versions[0]?.status_date?.split('T')[0]
      ?? versions[0]?.name
      ?? '进入时状态'
    dispatch(setComparison({ tasks: snap, versionName }))
    onShowComparison?.()
  }, [hasChanges, comparison, baseline, tasks, versions, dispatch, onShowComparison])


  // ── Export ─────────────────────────────────────────────────────────────
  const projectLines = useAppSelector(s => s.projectLines.lines)
  const [exportDropdown, setExportDropdown] = useState(false)
  const exportDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportDropdown) return
    const close = (e: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) setExportDropdown(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [exportDropdown])

  const handleExportExcel = useCallback(() => {
    exportToExcel(tasks, dependencies, currentProject?.name ?? '甘特图', currentProject?.status_date, projectLines)
    setExportDropdown(false)
  }, [tasks, dependencies, currentProject, projectLines])

  const handleExportJpeg = useCallback(async () => {
    setExportDropdown(false)
    await exportToJpeg(tasks, dependencies, currentProject?.name ?? '甘特图', currentProject?.status_date, projectLines,
      currentProject?.start_date, currentProject?.end_date)
  }, [tasks, dependencies, currentProject, projectLines])

  const handleExportPdf = useCallback(async () => {
    setExportDropdown(false)
    await exportToPdf(tasks, dependencies, currentProject?.name ?? '甘特图', currentProject?.status_date, projectLines,
      currentProject?.start_date, currentProject?.end_date)
  }, [tasks, dependencies, currentProject, projectLines])

  // ── Excel import ──────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can be re-selected

    try {
      const parsed = await parseExcelFile(file)
      if (parsed.tasks.length === 0) { alert('Excel 中没有找到有效任务数据'); return }

      // ── 客户端数据校验：阻止会导致渲染崩溃的数据 ──
      const validationErrors = validateImportData(parsed.tasks, parsed.dependencies)
      if (validationErrors.length > 0) {
        const msgs = validationErrors.map(e => `• ${e.message}`)
        alert(`导入数据校验失败，请修正 Excel 后重试：\n\n${msgs.join('\n')}`)
        return
      }

      // Let user choose import mode
      const choice = prompt(
        `解析到 ${parsed.tasks.length} 个任务和 ${parsed.dependencies.length} 个依赖关系。\n\n` +
        `请选择导入模式：\n` +
        `  1 = 替换导入（删除所有现有数据，用 Excel 数据替换）\n` +
        `  2 = 合并导入（保留现有数据，更新已有任务，新增新任务）\n\n` +
        `输入 1 或 2：`,
        '2'
      )
      if (!choice || (choice !== '1' && choice !== '2')) return

      const mode = choice === '1' ? 'replace' : 'merge'
      if (mode === 'replace') {
        const ok = confirm('⚠️ 替换导入将删除当前项目所有任务数据，此操作不可撤销。\n\n确认继续？')
        if (!ok) return
      }

      setImporting(true)
      // Ensure all dates are YYYY-MM-DD or null before sending
      const safeDateRe = /^\d{4}-\d{2}-\d{2}$/
      const safeTasks = parsed.tasks.map((t: ImportTask) => ({
        ...t,
        start_date: typeof t.start_date === 'string' && safeDateRe.test(t.start_date) ? t.start_date : null,
        end_date: typeof t.end_date === 'string' && safeDateRe.test(t.end_date) ? t.end_date : null,
      }))
      const res = await authFetch(`/api/import/${projectId}`, {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({
          tasks: safeTasks,
          dependencies: parsed.dependencies,
          mode,
          status_date: parsed.statusDate ?? undefined,
          project_lines: parsed.projectLines ?? undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        dispatch(setTasks({ tasks: data.value.tasks, dependencies: data.value.dependencies }))
        // Update status_date if returned
        if (data.value.status_date !== undefined) {
          dispatch(setStatusDate({ projectId, statusDate: data.value.status_date }))
        }
        // Update project lines if returned
        if (data.value.project_lines) {
          dispatch(setProjectLines(data.value.project_lines))
        }
        // 导入后刷新版本列表 + 自动加载对比基线
        if (data.value.version) {
          authFetch(`/api/versions/${projectId}?list=1`)
            .then(r => r.json())
            .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
            .catch(() => {})
          dispatch(setComparison({
            tasks: data.value.tasks.map((t: Task) => ({ ...t })),
            versionName: data.value.version.name ?? '导入版本',
          }))
        }
        alert(`导入成功！${data.value.message}`)
      } else {
        alert(`导入失败：${data.error ?? '未知错误'}`)
      }
    } catch (err) {
      alert(`解析 Excel 文件失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setImporting(false)
    }
  }, [dispatch, projectId])

  // ── Navigate prev/next task ───────────────────────────────────────────
  const flatOrder = getFlatOrder(tasks)
  const selectedIdx = hasSelection
    ? flatOrder.findIndex(t => t.id === selectedIds[0])
    : -1

  const handlePrev = useCallback(() => {
    if (selectedIdx <= 0) return
    dispatch(setSelectedIds([flatOrder[selectedIdx - 1].id]))
  }, [dispatch, flatOrder, selectedIdx])

  const handleNext = useCallback(() => {
    if (selectedIdx < 0 || selectedIdx >= flatOrder.length - 1) return
    dispatch(setSelectedIds([flatOrder[selectedIdx + 1].id]))
  }, [dispatch, flatOrder, selectedIdx])

  // ── Create task ───────────────────────────────────────────────────────
  const handleAddTask = useCallback(async () => {
    const fmtD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const projStartStr = currentProject?.start_date?.split('T')[0] ?? null
    const startD = projStartStr ? new Date(projStartStr + 'T00:00:00') : new Date()
    startD.setHours(0, 0, 0, 0)
    const startStr = fmtD(startD)
    const endD = new Date(startD); endD.setDate(endD.getDate() + 1)
    const endStr = fmtD(endD)

    const rootTasks = tasks.filter(t => t.parent_id === null)
    const nextIndex = rootTasks.length > 0
      ? Math.max(...rootTasks.map(t => t.order_index)) + 1 : 0

    const res = await authFetch(`/api/tasks/${projectId}`, {
      method: 'POST',
      headers: authFetchHeaders(true),
      body: JSON.stringify({
        parent_id: null, name: 'New Task',
        start_date: startStr, end_date: endStr,
        duration: 1, duration_unit: 'day',
        percent_done: 0, is_milestone: false, note: null, order_index: nextIndex,
      }),
    })
    const data = await res.json()
    if (data.ok && data.value?.length > 0) {
      dispatch(addTasks(data.value))
      dispatch(setSelectedIds([data.value[0].id]))
    }
  }, [dispatch, projectId, tasks, currentProject])

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDeleteTasks = useCallback(async () => {
    if (!hasSelection) return
    if (!confirm(`确定删除 ${selectedIds.length} 个任务？`)) return

    const res = await authFetch(`/api/tasks/${projectId}`, {
      method: 'DELETE',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ ids: selectedIds }),
    })
    const data = await res.json()
    if (data.ok) dispatch(deleteTasks(data.value.deleted))
  }, [dispatch, projectId, selectedIds, hasSelection])

  // ── Promote (升级) ────────────────────────────────────────────────────
  const handlePromote = useCallback(async () => {
    if (!hasSelection) return
    const selectedSet = new Set(selectedIds)
    const toPromote = tasks.filter(t =>
      selectedSet.has(t.id) && t.parent_id !== null && !selectedSet.has(t.parent_id ?? '')
    )
    if (toPromote.length === 0) return
    // 按原父级分组
    const groups = new Map<string, Task[]>()
    toPromote.forEach(t => {
      if (!groups.has(t.parent_id!)) groups.set(t.parent_id!, [])
      groups.get(t.parent_id!)!.push(t)
    })
    const allUpdates: Array<{ id: string; parent_id: string | null; order_index: number }> = []
    const alreadyShifted = new Set<string>()
    for (const [parentId, group] of groups) {
      const parent = tasks.find(t => t.id === parentId)!
      const grandparentId = parent.parent_id
      const sortedGroup = [...group].sort((a, b) => a.order_index - b.order_index)
      // 祖父级下后续兄弟后移，为提升的任务腾位
      tasks.filter(t =>
        t.parent_id === grandparentId && t.order_index > parent.order_index &&
        !selectedSet.has(t.id) && !alreadyShifted.has(t.id)
      ).forEach(t => {
        alreadyShifted.add(t.id)
        allUpdates.push({ id: t.id, parent_id: t.parent_id, order_index: t.order_index + sortedGroup.length })
      })
      // 将选中任务提升到父级同层
      sortedGroup.forEach((task, i) => {
        allUpdates.push({ id: task.id, parent_id: grandparentId, order_index: parent.order_index + 1 + i })
      })
      // 紧凑旧父级下剩余子任务的 order_index
      const promotedIds = new Set(sortedGroup.map(t => t.id))
      const remaining = tasks
        .filter(t => t.parent_id === parentId && !promotedIds.has(t.id))
        .sort((a, b) => a.order_index - b.order_index)
      remaining.forEach((t, i) => {
        if (t.order_index !== i && !alreadyShifted.has(t.id)) {
          allUpdates.push({ id: t.id, parent_id: t.parent_id, order_index: i })
        }
      })
    }


    // 升级时删除被升级任务与旧父任务之间的依赖关系
    const promotedIds = new Set(toPromote.map(t => t.id))
    const oldParentIdsForDeps = new Set(toPromote.map(t => t.parent_id!))
    const depsToRemove = dependencies.filter(d =>
      (promotedIds.has(d.from_task_id) && oldParentIdsForDeps.has(d.to_task_id)) ||
      (promotedIds.has(d.to_task_id) && oldParentIdsForDeps.has(d.from_task_id))
    )
    for (const dep of depsToRemove) {
      dispatch(removeDependency(dep.id))
      authFetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dep.id }),
      })
    }

    const movedTasks = allUpdates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))
    dispatch(updateTasks(movedTasks))
    // 乐观更新：旧父任务日期收缩（或恢复为普通任务）
    const oldParentIds = new Set(toPromote.map(t => t.parent_id!))
    const parentUpdates: Task[] = []
    for (const pid of oldParentIds) {
      const parent = tasks.find(t => t.id === pid)
      if (!parent) continue
      const promotedIds = new Set(toPromote.filter(t => t.parent_id === pid).map(t => t.id))
      const remainKids = tasks.filter(t => t.parent_id === pid && !promotedIds.has(t.id))
      if (remainKids.length === 0) {
        // 无子任务了，恢复为普通任务（保持原日期）
        continue
      }
      const starts = remainKids.map(k => k.start_date).filter(Boolean) as string[]
      const ends = remainKids.map(k => k.end_date).filter(Boolean) as string[]
      if (starts.length > 0 && ends.length > 0) {
        const minStart = starts.sort()[0]
        const maxEnd = ends.sort().reverse()[0]
        const d1 = new Date(minStart), d2 = new Date(maxEnd)
        const dur = Math.round((d2.getTime() - d1.getTime()) / 86400000)
        parentUpdates.push({ ...parent, start_date: minStart, end_date: maxEnd, duration: dur })
      }
    }
    if (parentUpdates.length > 0) dispatch(updateTasks(parentUpdates))

    dispatch(markDirty(allUpdates.map(u => u.id)))
  }, [dispatch, projectId, tasks, selectedIds, hasSelection, dependencies])

  // ── Demote (降级) ─────────────────────────────────────────────────────
  const handleDemote = useCallback(async () => {
    if (!hasSelection) return
    const selectedSet = new Set(selectedIds)
    const flatOrder = getFlatOrder(tasks)
    const toDemote = flatOrder.filter(t => selectedSet.has(t.id) && !selectedSet.has(t.parent_id ?? ''))
    if (toDemote.length === 0) return
    // 按父级分组，每组找各自的 anchor
    const groupsByParent = new Map<string, Task[]>()
    for (const t of toDemote) {
      const key = t.parent_id ?? '__root__'
      if (!groupsByParent.has(key)) groupsByParent.set(key, [])
      groupsByParent.get(key)!.push(t)
    }
    const allUpdates: Array<{ id: string; parent_id: string | null; order_index: number }> = []
    for (const [parentKey, group] of groupsByParent) {
      const parentId = parentKey === '__root__' ? null : parentKey
      const sortedGroup = [...group].sort((a, b) => a.order_index - b.order_index)
      const firstInGroup = sortedGroup[0]
      // 找同级中在选中任务前面的最近兄弟作为锚点
      const anchor = tasks
        .filter(t => (t.parent_id ?? null) === parentId && t.order_index < firstInGroup.order_index && !selectedSet.has(t.id))
        .sort((a, b) => b.order_index - a.order_index)[0]
      if (!anchor) continue // 该组无法降级（没有前面的兄弟）
      const existingChildren = tasks.filter(t => t.parent_id === anchor.id)
      const startOrder = existingChildren.length > 0
        ? Math.max(...existingChildren.map(t => t.order_index)) + 1 : 0
      sortedGroup.forEach((task, i) => {
        allUpdates.push({ id: task.id, parent_id: anchor.id, order_index: startOrder + i })
      })
    }
    if (allUpdates.length === 0) return


    // 降级时：删除被降级任务与新父任务之间的依赖，
    // 并且当 anchor 变为父级任务时，取消 anchor 上的所有依赖（父级任务不允许依赖）
    const demotedIds = new Set(allUpdates.map(u => u.id))
    const newParentIds = new Set(allUpdates.map(u => u.parent_id).filter(Boolean) as string[])
    const depsToRemove = dependencies.filter(d =>
      // 被降级任务与新父任务之间的依赖
      (demotedIds.has(d.from_task_id) && newParentIds.has(d.to_task_id)) ||
      (demotedIds.has(d.to_task_id) && newParentIds.has(d.from_task_id)) ||
      // 新父任务上的所有依赖（父级任务不允许有依赖）
      newParentIds.has(d.from_task_id) || newParentIds.has(d.to_task_id)
    )
    for (const dep of depsToRemove) {
      dispatch(removeDependency(dep.id))
      authFetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dep.id }),
      })
    }

    // 乐观更新：降级的任务 + 新父任务日期
    const movedTasks = allUpdates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))
    dispatch(updateTasks(movedTasks))
    // 立即计算受影响父任务的日期范围
    const affectedParentIds = new Set(allUpdates.map(u => u.parent_id).filter(Boolean) as string[])
    const parentUpdates: Task[] = []
    for (const pid of affectedParentIds) {
      const parent = tasks.find(t => t.id === pid)
      if (!parent) continue
      // 合并现有子任务 + 新增的子任务
      const existingKids = tasks.filter(t => t.parent_id === pid)
      const newKids = movedTasks.filter(t => t.parent_id === pid)
      const allKids = [...existingKids.filter(ek => !newKids.some(nk => nk.id === ek.id)), ...newKids]
      if (allKids.length === 0) continue
      const starts = allKids.map(k => k.start_date).filter(Boolean) as string[]
      const ends = allKids.map(k => k.end_date).filter(Boolean) as string[]
      if (starts.length === 0 || ends.length === 0) continue
      const minStart = starts.sort()[0]
      const maxEnd = ends.sort().reverse()[0]
      const d1 = new Date(minStart), d2 = new Date(maxEnd)
      const dur = Math.round((d2.getTime() - d1.getTime()) / 86400000)
      parentUpdates.push({ ...parent, start_date: minStart, end_date: maxEnd, duration: dur })
    }
    if (parentUpdates.length > 0) dispatch(updateTasks(parentUpdates))

    dispatch(markDirty(allUpdates.map(u => u.id)))
  }, [dispatch, projectId, tasks, selectedIds, hasSelection, dependencies])

  // ── Copy / Paste ──────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (!hasSelection) return
    dispatch(copyTasks(selectedIds))
  }, [dispatch, selectedIds, hasSelection])

  const handlePaste = useCallback(async () => {
    if (clipboard.length === 0) return


    // ── 确定插入位置：选中任务的正下方 ────────────────────────────────
    const flat = getFlatOrder(tasks)
    // 找到最后一个选中任务在 flat 中的位置
    let insertAfterIdx = -1
    for (let i = flat.length - 1; i >= 0; i--) {
      if (selectedIds.includes(flat[i].id)) { insertAfterIdx = i; break }
    }
    // 插入点的 parent_id 和 order_index
    const anchorTask = insertAfterIdx >= 0 ? flat[insertAfterIdx] : null
    const insertParentId = anchorTask?.parent_id ?? null
    // 同级兄弟列表，用于计算 order_index
    const siblings = tasks
      .filter(t => (t.parent_id ?? null) === insertParentId)
      .sort((a, b) => a.order_index - b.order_index)
    let insertOrderBase: number
    if (anchorTask) {
      const anchorIdx = siblings.findIndex(s => s.id === anchorTask.id)
      const anchorOrder = anchorTask.order_index
      const nextSibling = siblings[anchorIdx + 1]
      if (nextSibling) {
        // 在锚点和下一个兄弟之间插入
        insertOrderBase = anchorOrder + 1
        // 把后续兄弟的 order_index 往后推，腾出空间
        const shiftTasks = siblings.slice(anchorIdx + 1)
        const shiftPayload = shiftTasks.map((s, i) => ({
          id: s.id, order_index: anchorOrder + 1 + clipboard.length + i,
        }))
        if (shiftPayload.length > 0) {
          dispatch(updateTasks(shiftPayload.map(p => {
            const orig = tasks.find(t => t.id === p.id)!
            return { ...orig, order_index: p.order_index }
          })))
          dispatch(markDirty(shiftPayload.map(p => p.id)))
        }
      } else {
        insertOrderBase = anchorOrder + 1
      }
    } else {
      // 没有选中任务，追加到末尾
      insertOrderBase = siblings.length > 0
        ? Math.max(...siblings.map(s => s.order_index)) + 1 : 0
    }

    // 清理 parent_id：如果 parent 不在剪贴板中，则使用插入点的 parent_id
    const clipIds = new Set(clipboard.map(t => t.id))
    const pastedTasks = clipboard.map((t, i) => ({
      ...t,
      name: `${t.name} (copy)`,
      id: undefined,
      created_at: undefined,
      updated_at: undefined,
      parent_id: t.parent_id && clipIds.has(t.parent_id) ? t.parent_id : insertParentId,
      order_index: insertOrderBase + i,
    }))
    try {
      const res = await authFetch(`/api/tasks/${projectId}`, {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify(pastedTasks),
      })
      const data = await res.json()
      if (data.ok && Array.isArray(data.value)) {
        dispatch(addTasks(data.value))
        const newTasks: Task[] = data.value
        const newIds = newTasks.map(t => t.id)
        dispatch(setSelectedIds(newIds))

        // 构建 旧ID → 新ID 映射（按 clipboard 顺序一一对应）
        if (clipboardDeps.length > 0) {
          const oldIds = clipboard.map(t => t.id)
          const idMap = new Map<string, string>()
          oldIds.forEach((oldId, i) => {
            if (i < newTasks.length) idMap.set(oldId, newTasks[i].id)
          })

          // 逐条创建依赖（复用已有 API）
          for (const dep of clipboardDeps) {
            const newFrom = idMap.get(dep.from_task_id)
            const newTo = idMap.get(dep.to_task_id)
            if (!newFrom || !newTo) continue
            try {
              const depRes = await authFetch(`/api/dependencies/${projectId}`, {
                method: 'POST',
                headers: authFetchHeaders(true),
                body: JSON.stringify({
                  from_task_id: newFrom,
                  to_task_id: newTo,
                  type: dep.type,
                  lag: dep.lag,
                }),
              })
              const depData = await depRes.json()
              if (depData.ok && depData.value?.dependency) {
                dispatch(addDependency(depData.value.dependency))
                // 同步级联后更新的任务
                if (Array.isArray(depData.value.updatedTasks)) {
                  dispatch(updateTasks(depData.value.updatedTasks))
                }
              }
            } catch { /* ignore single dep failure */ }
          }
        }

        requestAnimationFrame(() => onFocusTask())
      }
    } catch { /* ignore network errors */ }
  }, [dispatch, projectId, clipboard, clipboardDeps, onFocusTask])

  // ── Status date: free movement + separate confirm button ────────
  const [statusDateSaving, setStatusDateSaving] = useState(false)

  // 自由移动状态日期（仅更新 Redux + 后端，不创建版本）
  const handleStatusDatePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value || null
    // 禁止选择未来日期
    if (val) {
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      if (val > today) {
        alert(`状态日期不能晚于今天 (${today})`)
        e.target.value = currentProject?.status_date?.split('T')[0] ?? ''
        return
      }
    }
    dispatch(setStatusDate({ projectId, statusDate: val }))
    await authFetch(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ status_date: val }),
    })
  }, [dispatch, projectId, currentProject?.status_date])

  // 确认变更：保存所有改动 + 重算完成度 + 创建版本快照
  const handleConfirmChanges = useCallback(async () => {
    const sd = currentProject?.status_date?.split('T')[0] ?? null
    if (!sd || statusDateSaving) return
    setStatusDateSaving(true)

    // 1. Recalculate percent_done + 快照 baseline_end_date
    //    baseline 取"上一期版本快照"的 end_date；若无上期，则用当前 end（首期无法比较）
    const sdDate = new Date(sd)
    const prevEndByTaskId = new Map<string, string | null>()
    const prevVersion = versions[0]
    if (prevVersion) {
      try {
        const r = await authFetch(`/api/versions/${projectId}?id=${prevVersion.id}`)
        const d = await r.json()
        if (d.ok && Array.isArray(d.value?.snapshot?.tasks)) {
          for (const pt of d.value.snapshot.tasks as { id: string; end_date: string | null }[]) {
            prevEndByTaskId.set(pt.id, pt.end_date ? String(pt.end_date).split('T')[0] : null)
          }
        }
      } catch { /* ignore, 退化为当前 end */ }
    }
    const updated = tasks
      .filter(t => t.start_date && t.end_date)
      .map(t => {
        const prevEnd = prevEndByTaskId.get(t.id) ?? null
        // 上期有该任务 → baseline = 上期 end；上期无（新增任务）或首期 → baseline = 当前 end
        const baseline = prevEnd ?? ((t.end_date ?? '').split('T')[0] || null)
        return {
          ...t,
          percent_done: calcPercent(t, sdDate),
          baseline_end_date: baseline,
        }
      })
    if (updated.length > 0) {
      dispatch(updateTasks(updated))
      const payload = updated.map(t => ({
        id: t.id,
        percent_done: t.percent_done,
        baseline_end_date: t.baseline_end_date,
      }))
      await authFetch(`/api/tasks/${projectId}`, {
        method: 'PUT',
        headers: authFetchHeaders(true),
        body: JSON.stringify(payload),
      })
      dispatch(clearDirty())
    }

    // 2. Save any dirty tasks
    if (dirtyIds.length > 0) {
      const dirtyTasks = tasks.filter(t => dirtyIds.includes(t.id))
      const dirtyPayload = dirtyTasks.map(t => ({
        id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date,
        duration: t.duration, percent_done: t.percent_done, parent_id: t.parent_id,
        order_index: t.order_index, is_milestone: t.is_milestone, auto_schedule: t.auto_schedule,
        assignee: t.assignee, note: t.note,
        constraint_type: t.constraint_type, constraint_date: t.constraint_date,
        status: t.status,
        rollup: t.rollup, inactive: t.inactive, project_boundary: t.project_boundary,
      }))
      await authFetch(`/api/tasks/${projectId}`, {
        method: 'PUT',
        headers: authFetchHeaders(true),
        body: JSON.stringify(dirtyPayload),
      })
      dispatch(clearDirty())
    }

    // 3. Create version snapshot（2个状态日期间的变更都算在这个版本上）
    const reasonMap: Record<string, string> = {}
    for (const d of changeDiffs) {
      if (primaryCodes.has(d.task_code)) {
        const r = (reasons[d.task_code] ?? '').trim()
        if (r) reasonMap[d.task_code] = r
      } else if (passiveReasonMap[d.task_code]) {
        reasonMap[d.task_code] = passiveReasonMap[d.task_code]
      }
    }
    const snapshotRes = await authFetch(`/api/versions/${projectId}`, {
      method: 'POST',
      headers: authFetchHeaders(true),
      body: JSON.stringify({
        tasks, dependencies,
        status_date: sd,
        reasons: reasonMap,
      }),
    })
    const snapshotData = await snapshotRes.json()

    setStatusDateSaving(false)

    if (snapshotData.ok) {
      dispatch(clearDirty())

      // 重置基线为当前任务，使 changeDiffs 变空 → hasChanges = false
      setBaseline(tasks.filter(t => !t.is_deleted).map(t => ({
        id: t.id, task_code: t.task_code, name: t.name,
        start_date: t.start_date, end_date: t.end_date,
        duration: t.duration, assignee: t.assignee,
        percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
        parent_id: t.parent_id,
      })))

      // 自动将当前状态设为对比基线，后续编辑可立即看到计划偏差
      dispatch(setComparison({ tasks: tasks.map(t => ({ ...t })), versionName: sd }))
      comparisonShownRef.current = false

      authFetch(`/api/versions/${projectId}?list=1`)
        .then(r => r.json())
        .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
        .catch(() => {})
    }
  }, [currentProject, lastVersionDate, statusDateSaving, dispatch, projectId, tasks, dependencies, dirtyIds, changeDiffs, onAutoAI, versions, reasons, primaryCodes, passiveReasonMap])

  // ── 放弃更改：重新加载任务（等同于返回项目列表再进入）
  const handleRefresh = useCallback(async () => {
    try {
      const res = await authFetch(`/api/tasks/${projectId}`)
      const data = await res.json()
      if (data.ok && data.value) {
        dispatch(setTasks({
          tasks: Array.isArray(data.value.tasks) ? data.value.tasks : [],
          dependencies: Array.isArray(data.value.dependencies) ? data.value.dependencies : [],
        }))
        dispatch(clearDirty())
        comparisonShownRef.current = false
        dispatch(clearComparison())
        // 用刚加载的任务重建基线
        const freshTasks = Array.isArray(data.value.tasks) ? data.value.tasks : []
        setBaseline(freshTasks.filter((t: any) => !t.is_deleted).map((t: any) => ({
          id: t.id, task_code: t.task_code, name: t.name,
          start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, assignee: t.assignee,
          percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
          parent_id: t.parent_id,
        })))
      }
    } catch { /* ignore */ }
  }, [dispatch, projectId])

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (readOnly) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') handleCopy()
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') handlePaste()
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch, handleCopy, handlePaste, readOnly])

  const sep = <div className="w-px h-6 bg-gray-200 mx-1" />

  return (
    <>
      <div className="relative z-20 flex items-center gap-1.5 px-3 py-2 bg-white border-b border-gray-200 flex-wrap">

        {readOnly && (
          <span className="text-[11px] text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-1 font-medium whitespace-nowrap">
            只读模式
          </span>
        )}

        {!readOnly && (
          <>
            {/* Group 1: Create + Edit */}
            <Ic title="创建任务" onClick={handleAddTask}><IcoPlus /></Ic>
            <Ic title="编辑任务" disabled={selectedIds.length !== 1}
                     onClick={() => selectedIds.length === 1 && setEditModalOpen(true)}>
              <IcoPencil />
            </Ic>

            {sep}
          </>
        )}

        {readOnly && sep}

        {/* Group 3: Expand / Collapse all */}
        <Ic title="全部展开" onClick={onExpandAll}><IcoExpand /></Ic>
        <Ic title="全部折叠" onClick={onCollapseAll}><IcoCollapse /></Ic>

        {sep}

        {/* Group 4: Zoom + Focus + Indent/Outdent */}
        <Ic title={`放大 (当前: ${colW}px)`} disabled={colW >= 56} onClick={onZoomIn}><IcoZoomIn /></Ic>
        <Ic title={`缩小 (当前: ${colW}px)`} disabled={colW <= 3} onClick={onZoomOut}><IcoZoomOut /></Ic>
        <Ic title="聚焦到选中任务" disabled={!hasSelection} onClick={onFocusTask}><IcoFocus /></Ic>
        {!readOnly && <Ic title="升级 (Outdent)" disabled={!hasSelection} onClick={handlePromote}><IcoPrev /></Ic>}
        {!readOnly && <Ic title="降级 (Indent)"  disabled={!hasSelection} onClick={handleDemote}><IcoNext /></Ic>}

        {sep}

        {/* Search */}
        <div className="flex items-center gap-1 border border-gray-300 rounded px-2 h-8 bg-white">
          <IcoSearch />
          <input
            type="text"
            placeholder="搜索任务..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="w-36 text-[13px] outline-none placeholder:text-gray-400"
          />
          {searchQuery && (
            <button onClick={() => onSearchChange('')} className="text-gray-400 hover:text-gray-600 text-sm">×</button>
          )}
        </div>

        {!readOnly && (
          <>
            {sep}

            {/* Secondary: Copy / Paste / Delete */}
            <Ic title="复制 (Ctrl+C)" disabled={!hasSelection} onClick={handleCopy}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8" strokeLinecap="round"/>
              </svg>
            </Ic>
            <Ic title="粘贴 (Ctrl+V)" disabled={clipboard.length === 0} onClick={handlePaste}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M5 3h6v2H5V3z"/><rect x="3" y="4" width="10" height="10" rx="1"/>
              </svg>
            </Ic>
            <Ic title="删除选中任务" disabled={!hasSelection} onClick={handleDeleteTasks}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 5h10M6 5V3h4v2M7 8v4M9 8v4" strokeLinecap="round"/>
                <path d="M4 5l1 9h6l1-9H4z"/>
              </svg>
            </Ic>

            {sep}

            {/* Status date */}
            <div className="flex items-center gap-1.5 relative">
              <span className="text-xs text-gray-500 whitespace-nowrap">状态日期</span>
              {(() => {
                const now = new Date()
                const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
                const v = currentProject?.status_date?.split('T')[0] ?? ''
                return (
                  <YmdDateInput value={v} max={today} onChange={handleStatusDatePick} />
                )
              })()}
              {(() => {
                const sd = currentProject?.status_date?.split('T')[0] ?? null
                const now = new Date()
                const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
                const isFuture = !!sd && sd > today
                const statusDateAdvanced = !!sd && (!lastVersionDate || sd > lastVersionDate)
                const canSubmit = !!currentProject?.status_date && !statusDateSaving && !isFuture && (hasChanges || statusDateAdvanced)
                const label = hasChanges ? '确认变更' : '保存状态日期'
                const tip = !currentProject?.status_date
                  ? '请先设置状态日期'
                  : isFuture ? `状态日期不能晚于今天 (${today})`
                  : hasChanges ? '确认变更：保存所有改动并创建版本快照'
                  : statusDateAdvanced ? '没有任务变更，直接为当前状态日期保存一个快照'
                  : '状态日期未变化，无需保存'
                return (
                  <button
                    onClick={() => {
                      if (!sd) { alert('请先设置状态日期'); return }
                      if (sd > today) {
                        alert(`状态日期不能晚于今天 (${today})`); return
                      }
                      if (lastVersionDate && sd < lastVersionDate) {
                        alert(`状态日期不能早于上一版本 (${lastVersionDate})`); return
                      }
                      if (hasChanges) openReview()
                      else handleConfirmChanges()
                    }}
                    disabled={!canSubmit}
                    title={tip}
                    className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                      ${canSubmit
                        ? hasChanges
                          ? 'border-green-500 text-green-700 bg-green-50 hover:bg-green-100 cursor-pointer'
                          : 'border-blue-400 text-blue-700 bg-blue-50 hover:bg-blue-100 cursor-pointer'
                        : 'border-gray-200 text-gray-300 bg-gray-50 cursor-not-allowed'}`}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {statusDateSaving ? '保存中...' : label}
                  </button>
                )
              })()}
              {!readOnly && (
                <button
                  onClick={handleRefresh}
                  disabled={!hasChanges}
                  title="放弃所有未保存的更改"
                  className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                    ${hasChanges
                      ? 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50 cursor-pointer'
                      : 'border-gray-200 text-gray-300 bg-gray-50 cursor-not-allowed'}`}
                >
                  <IcoRefresh />
                  放弃更改
                </button>
              )}
              <button
                onClick={handleToggleCompareLock}
                title={comparison ? `退出对比模式（当前对比：${comparison.versionName}）` : '进入对比模式，默认对比最近一次快照；可在历史版本面板切换对比目标'}
                className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                  ${comparison
                    ? 'border-orange-500 text-orange-700 bg-orange-50 hover:bg-orange-100 cursor-pointer'
                    : 'border-gray-300 text-gray-600 bg-white hover:bg-gray-50 cursor-pointer'}`}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="8" cy="8" r="2.5"/>
                </svg>
                {comparison ? `对比中: ${comparison.versionName}` : '对比模式'}
              </button>
              <div className="relative">
                <button
                  onClick={() => setVersionPanelOpen(v => !v)}
                  title="历史版本"
                  className={`inline-flex items-center justify-center w-8 h-8 rounded border transition-colors cursor-pointer
                    ${versionPanelOpen
                      ? 'border-orange-500 text-orange-600 bg-orange-100'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50 bg-white'}`}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M8 3v5l3 2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 8a6 6 0 1 0 2-4.5" strokeLinecap="round"/>
                    <path d="M2 2v3h3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <VersionPanel
                  projectId={projectId}
                  open={versionPanelOpen}
                  onClose={() => setVersionPanelOpen(false)}
                  readOnly={readOnly}
                />
              </div>
            </div>

          </>
        )}

        {/* 只读模式下仍允许调整状态日期（本地生效，不落库） */}
        {readOnly && (
          <>
            {sep}
            <span className="text-xs text-gray-500 whitespace-nowrap">状态日期</span>
            <YmdDateInput
              value={currentProject?.status_date?.split('T')[0] ?? ''}
              onChange={handleStatusDatePick}
            />
          </>
        )}

        {/* Comparison indicator + show/hide toggle */}
        {comparison && (
          <span className="inline-flex items-center h-8 rounded border border-orange-300 bg-orange-50 text-[12px] font-medium">
            <span className="inline-flex items-center gap-1 pl-2.5 pr-1 h-full text-orange-600">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 8h12M8 2v12" strokeLinecap="round"/>
              </svg>
              <span className="text-[11px] text-orange-500">基准</span>
              <select
                value={versions.find(v => (v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`) === comparison.versionName)?.id ?? ''}
                onChange={async e => {
                  const vid = e.target.value
                  const v = versions.find(x => x.id === vid)
                  if (!v) return
                  try {
                    const r = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
                    const d = await r.json()
                    if (d.ok && d.value?.snapshot?.tasks) {
                      dispatch(setComparison({
                        tasks: d.value.snapshot.tasks,
                        versionName: v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`,
                      }))
                    }
                  } catch { /* ignore */ }
                }}
                className="bg-transparent border-none text-orange-700 text-[12px] font-medium focus:outline-none cursor-pointer pr-4"
                title="基准版本（以基线条显示）"
              >
                {versions.map(v => {
                  const label = v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`
                  return <option key={v.id} value={v.id}>{label}</option>
                })}
              </select>
              <span className="text-orange-400">vs</span>
              <select
                value={viewSnapshot?.versionId ?? '__current__'}
                onChange={async e => {
                  const vid = e.target.value
                  if (vid === '__current__') {
                    dispatch(clearViewSnapshot())
                    return
                  }
                  const v = versions.find(x => x.id === vid)
                  if (!v) return
                  try {
                    const r = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
                    const d = await r.json()
                    if (d.ok && d.value?.snapshot) {
                      dispatch(setViewSnapshot({
                        tasks: d.value.snapshot.tasks ?? [],
                        dependencies: d.value.snapshot.dependencies ?? [],
                        versionId: v.id,
                        versionName: v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`,
                      }))
                    }
                  } catch { /* ignore */ }
                }}
                className="bg-transparent border-none text-orange-700 text-[12px] font-medium focus:outline-none cursor-pointer pr-4"
                title="对比目标（作为主视图显示）"
              >
                <option value="__current__">当前</option>
                {versions.map(v => {
                  const label = v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`
                  return <option key={v.id} value={v.id}>{label}</option>
                })}
              </select>
            </span>
            {onToggleComparison && (
              <button
                onClick={onToggleComparison}
                title={showComparison ? '隐藏对比' : '显示对比'}
                className="inline-flex items-center px-1.5 h-full text-orange-500 hover:text-orange-700 hover:bg-orange-100 border-l border-orange-200 cursor-pointer">
                {showComparison ? (
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round"/>
                    <circle cx="8" cy="8" r="2.5"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round"/>
                    <circle cx="8" cy="8" r="2.5"/>
                    <path d="M2 14L14 2" strokeLinecap="round"/>
                  </svg>
                )}
              </button>
            )}
            <button
              onClick={() => { dispatch(clearComparison()); dispatch(clearViewSnapshot()) }}
              title="取消对比"
              className="inline-flex items-center px-1.5 h-full text-orange-400 hover:text-orange-600 hover:bg-orange-100 rounded-r border-l border-orange-200 cursor-pointer">
              ×
            </button>
          </span>
        )}

        {/* Diff filter indicator */}
        {diffFilter && (
          <span className="inline-flex items-center h-8 rounded border border-purple-300 bg-purple-50 text-[12px] font-medium">
            <span className="inline-flex items-center gap-1.5 px-2.5 h-full text-purple-600">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h12M4 8h8M6 13h4" strokeLinecap="round"/>
              </svg>
              差异: {diffFilter.versionName}
              <span className="text-purple-400 text-[10px]">({diffFilter.taskCodes.length})</span>
            </span>
            <button
              onClick={() => { dispatch(clearDiffFilter()); dispatch(clearComparison()) }}
              title="取消差异筛选"
              className="inline-flex items-center px-1.5 h-full text-purple-400 hover:text-purple-600 hover:bg-purple-100 rounded-r border-l border-purple-200 cursor-pointer">
              ×
            </button>
          </span>
        )}

        {sep}

        {/* Export dropdown */}
        <div className="relative">
          <Ic title="导出" onClick={() => setExportDropdown(v => !v)}><IcoDownload /></Ic>
          {exportDropdown && (
            <div ref={exportDropdownRef}
                 className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-lg py-1 min-w-[140px]">
              <button className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                      onClick={handleExportExcel}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h4"/></svg>
                导出 Excel
              </button>
              <button className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                      onClick={handleExportJpeg}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="6" cy="10" r="1.5"/><path d="M8 5l3 4H5z"/></svg>
                导出图片 (JPEG)
              </button>
              <button className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                      onClick={handleExportPdf}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h2.5a1.5 1.5 0 010 3H5V5z" fill="currentColor" opacity="0.3"/><path d="M5 11h6"/></svg>
                导出 PDF
              </button>
            </div>
          )}
        </div>

        {/* Excel import */}
        {!readOnly && (
          <>
            <Ic title="导入 Excel" onClick={() => fileInputRef.current?.click()} disabled={importing}><IcoUpload /></Ic>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
          </>
        )}

        {sep}

        {/* Critical Path toggle */}
        {onToggleCriticalPath && (
          <button
            onClick={onToggleCriticalPath}
            title="显示/隐藏关键路径"
            className={`inline-flex items-center gap-1.5 px-2.5 h-8 rounded border text-[13px] font-medium cursor-pointer
                       ${showCriticalPath
                         ? 'border-red-400 text-red-600 bg-red-50 hover:bg-red-100'
                         : 'border-gray-300 text-gray-600 hover:bg-gray-50 bg-white'}`}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M1 8h3l2-5 3 10 2-5h4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            关键路径
          </button>
        )}

        {/* Project Lines + AI */}
        {onToggleProjectLines && (
          <Ic title="项目线管理" onClick={onToggleProjectLines}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#f59e0b" strokeWidth="1.8">
              <path d="M8 1v14M4 1v14M12 1v14" strokeLinecap="round" strokeDasharray="2 2"/>
            </svg>
          </Ic>
        )}
        {/* 历史变更记录 */}
        <Ic title="历史变更记录" onClick={() => setRetroLogOpen(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v5h5"/>
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>
            <path d="M12 7v5l3 2"/>
          </svg>
        </Ic>

        {/* Column settings */}
        {visibleCols && onVisibleColsChange && (
          <div ref={colSettingsRef} className="relative">
            <Ic title="列设置" onClick={() => setColSettingsOpen(v => !v)} active={colSettingsOpen}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </Ic>
            {colSettingsOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-lg py-1.5 min-w-[180px] whitespace-nowrap">
                <div className="px-3 py-1 text-[11px] text-gray-500 border-b border-gray-100 font-semibold flex items-center justify-between gap-2">
                <span>显示列</span>
                <span className="flex gap-1">
                  {[
                    { label: '全选', action: () => onVisibleColsChange(OPTIONAL_COL_META.map(c => c.key)) },
                    { label: '全不选', action: () => onVisibleColsChange([]) },
                    { label: '反选', action: () => onVisibleColsChange(OPTIONAL_COL_META.filter(c => !visibleCols.includes(c.key)).map(c => c.key)) },
                  ].map(b => (
                    <button key={b.label} onClick={b.action}
                            className="px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100 rounded">
                      {b.label}
                    </button>
                  ))}
                </span>
              </div>
                {OPTIONAL_COL_META.map(col => (
                  <label key={col.key}
                         className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-blue-50">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-blue-500"
                      checked={visibleCols.includes(col.key)}
                      onChange={() => {
                        onVisibleColsChange(
                          visibleCols.includes(col.key)
                            ? visibleCols.filter(k => k !== col.key)
                            : [...visibleCols, col.key]
                        )
                      }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Indicators settings */}
        {indicators && onIndicatorsChange && (
          <div ref={indicatorsRef} className="relative">
            <Ic title="指示器" onClick={() => setIndicatorsOpen(v => !v)} active={indicatorsOpen}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4v16"/>
                <path d="M4 4h12l-3 4 3 4H4"/>
                <circle cx="18" cy="18" r="2" fill="currentColor"/>
              </svg>
            </Ic>
            {indicatorsOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-lg py-1.5 min-w-[160px] whitespace-nowrap">
                <div className="px-3 py-1 text-[11px] text-gray-500 border-b border-gray-100 font-semibold">
                  指示器
                </div>
                {INDICATOR_META.map(item => (
                  <label key={item.key}
                         className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-blue-50">
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 accent-blue-500"
                      checked={!!indicators[item.key]}
                      onChange={() => onIndicatorsChange({ ...indicators, [item.key]: !indicators[item.key] })}
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {onToggleAI && (
          <LabelIc
            icon={
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            }
            label="AI"
            variant="blue"
            onClick={onToggleAI}
          />
        )}
      </div>

      {retroLogOpen && (
        <RetroLogPanel projectId={projectId} onClose={() => setRetroLogOpen(false)} />
      )}

      {/* Edit Task Modal */}
      {editModalOpen && selectedIds.length === 1 && (
        <EditTaskModal
          taskId={selectedIds[0]}
          projectId={projectId}
          onClose={() => setEditModalOpen(false)}
        />
      )}

      {/* Review Changes Dialog */}
      {reviewOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                变更审核
                <span className="ml-2 text-xs font-normal text-gray-500">
                  状态日期: {currentProject?.status_date?.split('T')[0]}
                </span>
              </h3>
              <button onClick={() => setReviewOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none cursor-pointer">×</button>
            </div>

            {/* Stats bar */}
            <div className="flex gap-4 px-5 py-2.5 bg-gray-50 border-b border-gray-100 text-xs">
              {(() => {
                const added = changeDiffs.filter(d => d.type === 'added').length
                const removed = changeDiffs.filter(d => d.type === 'removed').length
                const changed = changeDiffs.filter(d => d.type === 'changed').length
                return (
                  <>
                    {added > 0 && <span className="text-green-600">+ 新增 {added}</span>}
                    {changed > 0 && <span className="text-blue-600">~ 修改 {changed}</span>}
                    {removed > 0 && <span className="text-red-600">- 删除 {removed}</span>}
                    <span className="text-gray-400 ml-auto">共 {changeDiffs.length} 项变更</span>
                  </>
                )
              })()}
            </div>

            {/* Diff list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
              {changeDiffs.length === 0 ? (
                <div className="text-center text-gray-400 py-8 text-sm">没有检测到变更</div>
              ) : (
                changeDiffs.map((d, i) => (
                  <div key={i} className={`rounded border px-3 py-2 text-[13px] ${
                    d.type === 'added' ? 'border-green-200 bg-green-50'
                    : d.type === 'removed' ? 'border-red-200 bg-red-50'
                    : 'border-blue-200 bg-blue-50'
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${
                        d.type === 'added' ? 'bg-green-200 text-green-800'
                        : d.type === 'removed' ? 'bg-red-200 text-red-800'
                        : 'bg-blue-200 text-blue-800'
                      }`}>
                        {d.type === 'added' ? '新增' : d.type === 'removed' ? '删除' : '修改'}
                      </span>
                      <span className="text-gray-500 text-xs">{d.task_code}</span>
                      <span className="font-medium text-gray-800">{d.task_name}</span>
                    </div>
                    {d.changes && d.changes.length > 0 && (
                      <div className="mt-1.5 space-y-0.5 pl-2 border-l-2 border-blue-200">
                        {d.changes.map((c, j) => (
                          <div key={j} className="text-xs text-gray-600">
                            <span className="text-gray-400">{c.field}:</span>{' '}
                            <span className="line-through text-red-500/70">{c.old}</span>
                            {' → '}
                            <span className="text-green-700">{c.new}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2">
                      {primaryCodes.has(d.task_code) ? (
                        <textarea
                          value={reasons[d.task_code] ?? ''}
                          onChange={e => setReasons(prev => ({ ...prev, [d.task_code]: e.target.value }))}
                          placeholder="变更原因（必填）"
                          rows={2}
                          className={`w-full text-xs px-2 py-1 rounded border resize-y bg-white focus:outline-none ${
                            (reasons[d.task_code] ?? '').trim().length === 0
                              ? 'border-red-300 focus:border-red-400'
                              : 'border-gray-300 focus:border-blue-400'
                          }`}
                        />
                      ) : (
                        <div className="text-xs text-gray-500 italic px-2 py-1 rounded border border-dashed border-gray-200 bg-gray-50">
                          {passiveReasonMap[d.task_code] ?? '被动变更'}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => setReviewOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => { setReviewOpen(false); handleConfirmChanges() }}
                disabled={statusDateSaving || !allReasonsFilled}
                title={!allReasonsFilled ? '请为每项变更填写原因' : ''}
                className="px-4 py-2 text-sm text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer"
              >
                {statusDateSaving ? '保存中...' : '确认并保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
