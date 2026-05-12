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
import { toDateTimeStr, addMinutesStr } from '@/lib/clientTime'
import { exportToExcel } from '@/lib/client/excelExport'
import { exportToJpeg, exportToPdf } from '@/lib/client/chartExport'
import { parseExcelFile, validateImportData, type ImportTask, type ImportDep, type ImportProjectLine } from '@/lib/client/excelImport'
import { setProjectLines } from '@/store/slices/projectLinesSlice'
import { OPTIONAL_COL_META, type OptionalCol, INDICATOR_META, type IndicatorsConfig } from './GanttChart'
import VersionPanel from './VersionPanel'
import RetroLogPanel from './RetroLogPanel'
import { diffSnapshots, type SnapshotTask, type DiffItem } from '@/lib/versionDiff'
import { runFullCascade } from '@/lib/clientScheduling'
import { buildSaveDiff, hasAnyDiff } from '@/lib/clientSave'
import { uuid } from '@/lib/uuid'
import type { Dependency } from '@/types'

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

// 年-月-日（可选带 时:分）输入：显示文本 + 隐藏原生 date/datetime-local 控件
function YmdDateInput({
  value, max, min, onChange, includeTime = false,
}: {
  value: string
  max?: string
  min?: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  includeTime?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const openPicker = () => {
    const el = ref.current
    if (!el) return
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return } catch { /* fall through */ }
    }
    el.focus()
  }
  // value 形如 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm[:ss]'，统一裁出展示串与控件值
  const isoLen = includeTime ? 16 : 10
  const ctlVal = (value || '').slice(0, isoLen)
  const dispVal = includeTime ? ctlVal.replace('T', ' ') : ctlVal
  const placeholder = includeTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'
  const width = includeTime ? 'w-[160px]' : 'w-[120px]'
  return (
    <div className="relative inline-flex items-center">
      <input
        readOnly
        type="text"
        value={dispVal}
        placeholder={placeholder}
        onClick={openPicker}
        onFocus={openPicker}
        className={`border border-gray-300 rounded pl-2 pr-7 h-8 text-[13px] ${width} bg-white cursor-pointer focus:outline-none focus:border-blue-400`}
      />
      <svg viewBox="0 0 24 24" width="14" height="14"
           className="absolute right-2 pointer-events-none text-gray-500"
           fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
      <input
        ref={ref}
        type={includeTime ? 'datetime-local' : 'date'}
        value={ctlVal}
        max={max}
        min={min}
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
  isMinute?: boolean  // 项目精度：true=分钟级，false=天级
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
  visibleCols?: OptionalCol[]
  onVisibleColsChange?: (cols: OptionalCol[]) => void
  indicators?: IndicatorsConfig
  onIndicatorsChange?: (next: IndicatorsConfig) => void
}

export default function GanttToolbar({
  projectId,
  readOnly,
  isMinute = false,
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
  visibleCols,
  onVisibleColsChange,
  indicators,
  onIndicatorsChange,
}: GanttToolbarProps) {
  const dispatch = useAppDispatch()
  const { selectedIds, clipboard, clipboardDeps, tasks, dependencies, dirtyIds, editDescriptions, comparison, viewSnapshot, diffFilter } = useAppSelector(s => s.tasks)
  const currentProject = useAppSelector(s => s.project.currentProject)
  const { versions } = useAppSelector(s => s.versions)

  // 上一版本带状态日期的快照（保存时校验：新版本状态日期必须严格大于旧版本）
  // 分钟级：保留完整 datetime，不再裁到日。
  const lastVersionDate = React.useMemo(() => {
    const latest = versions.find(v => !v.is_autosave && v.status_date)
    return toDateTimeStr(latest?.status_date ?? null)
  }, [versions])

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
  const [viewVersionOpen, setViewVersionOpen] = useState(false)
  const viewVersionRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!viewVersionOpen) return
    const close = (e: MouseEvent) => {
      if (viewVersionRef.current && !viewVersionRef.current.contains(e.target as Node)) setViewVersionOpen(false)
    }
    setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => document.removeEventListener('mousedown', close)
  }, [viewVersionOpen])

  // 切换到指定历史版本（只读浏览）
  const handleEnterViewSnapshot = useCallback(async (versionId: string) => {
    const v = versions.find(x => x.id === versionId)
    if (!v) return
    try {
      const r = await authFetch(`/api/versions/${projectId}?id=${versionId}`)
      const d = await r.json()
      if (d.ok && d.value?.snapshot) {
        dispatch(setViewSnapshot({
          tasks: Array.isArray(d.value.snapshot.tasks) ? d.value.snapshot.tasks : [],
          dependencies: Array.isArray(d.value.snapshot.dependencies) ? d.value.snapshot.dependencies : [],
          versionId: v.id,
          versionName: v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`,
        }))
      }
    } catch { /* ignore */ }
    setViewVersionOpen(false)
  }, [versions, projectId, dispatch])

  // ── 变更检测（纯本地，不依赖 API）──────────────────────────────────
  // 基线：首次加载任务时捕获快照，作为"上次入库状态"。所有编辑只改 Redux，
  // "保存版本"时与基线 diff 出增删改，批量落库后基线重置为当前状态。
  const [baseline, setBaseline] = useState<SnapshotTask[] | null>(null)
  const [baselineTasks, setBaselineTasks] = useState<Task[]>([])
  const [baselineDeps, setBaselineDeps] = useState<Dependency[]>([])

  // 任务首次加载完成时，捕获当前状态作为基线
  const baselineCapturedRef = useRef(false)
  useEffect(() => {
    if (tasks.length === 0) {
      baselineCapturedRef.current = false
      setBaseline(null)
      setBaselineTasks([])
      setBaselineDeps([])
      return
    }
    if (baselineCapturedRef.current) return
    baselineCapturedRef.current = true
    const livingTasks = tasks.filter(t => !t.is_deleted)
    setBaseline(livingTasks.map(t => ({
      id: t.id, task_code: t.task_code, name: t.name,
      start_date: t.start_date, end_date: t.end_date,
      duration: t.duration, assignee: t.assignee,
      percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
      parent_id: t.parent_id,
    })))
    setBaselineTasks(livingTasks.map(t => ({ ...t })))
    setBaselineDeps(dependencies.map(d => ({ ...d })))
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

  // 依赖变更检测：添加/删除/修改 lag/type/active（任务字段 diff 不包含依赖）
  const DEP_TYPE_LABEL = ['SS', 'SF', 'FS', 'FF']
  interface DepChangeItem {
    id: string
    type: 'added' | 'removed' | 'updated'
    fromCode: string; fromName: string
    toCode: string; toName: string
    depTypeLabel: string
    changes?: { field: string; old: string; new: string }[]
  }
  const depDiff = React.useMemo(() => {
    const baseMap = new Map(baselineDeps.map(d => [d.id, d]))
    const curMap = new Map(dependencies.map(d => [d.id, d]))
    // 用 baselineTasks + 当前 tasks 联合查询任务名/编码（删除的任务也能找到）
    const taskInfoMap = new Map<string, { code: string; name: string }>()
    for (const t of baselineTasks) taskInfoMap.set(t.id, { code: t.task_code, name: t.name })
    for (const t of tasks) taskInfoMap.set(t.id, { code: t.task_code, name: t.name })
    const lookup = (id: string) => taskInfoMap.get(id) ?? { code: '?', name: '(未知任务)' }

    const items: DepChangeItem[] = []
    for (const [id, cur] of curMap) {
      const old = baseMap.get(id)
      const fi = lookup(cur.from_task_id), ti = lookup(cur.to_task_id)
      const tLabel = DEP_TYPE_LABEL[cur.type ?? 2] ?? 'FS'
      if (!old) {
        items.push({
          id, type: 'added',
          fromCode: fi.code, fromName: fi.name,
          toCode: ti.code, toName: ti.name,
          depTypeLabel: tLabel,
        })
        continue
      }
      const changes: { field: string; old: string; new: string }[] = []
      if ((old.type ?? null) !== (cur.type ?? null))
        changes.push({ field: '类型', old: DEP_TYPE_LABEL[old.type ?? 2] ?? 'FS', new: tLabel })
      if ((old.lag ?? 0) !== (cur.lag ?? 0))
        changes.push({ field: '延迟', old: `${old.lag ?? 0}d`, new: `${cur.lag ?? 0}d` })
      if ((old.active ?? true) !== (cur.active ?? true))
        changes.push({ field: '状态', old: (old.active ?? true) ? '启用' : '禁用', new: (cur.active ?? true) ? '启用' : '禁用' })
      if (old.from_task_id !== cur.from_task_id || old.to_task_id !== cur.to_task_id) {
        const ofI = lookup(old.from_task_id), otI = lookup(old.to_task_id)
        changes.push({ field: '端点', old: `${ofI.code}→${otI.code}`, new: `${fi.code}→${ti.code}` })
      }
      if (changes.length > 0) {
        items.push({
          id, type: 'updated',
          fromCode: fi.code, fromName: fi.name,
          toCode: ti.code, toName: ti.name,
          depTypeLabel: tLabel,
          changes,
        })
      }
    }
    for (const [id, old] of baseMap) {
      if (curMap.has(id)) continue
      const fi = lookup(old.from_task_id), ti = lookup(old.to_task_id)
      items.push({
        id, type: 'removed',
        fromCode: fi.code, fromName: fi.name,
        toCode: ti.code, toName: ti.name,
        depTypeLabel: DEP_TYPE_LABEL[old.type ?? 2] ?? 'FS',
      })
    }
    const added = items.filter(i => i.type === 'added').length
    const updated = items.filter(i => i.type === 'updated').length
    const removed = items.filter(i => i.type === 'removed').length
    return { items, added, updated, removed, total: items.length }
  }, [baselineDeps, dependencies, baselineTasks, tasks])

  const hasChanges = changeDiffs.length > 0 || depDiff.total > 0

  // 变更审核弹窗状态
  const [reviewOpen, setReviewOpen] = useState(false)
  // 每个变更项的原因（key = task_code）
  const [reasons, setReasons] = useState<Record<string, string>>({})

  // 对比模式：仅以"上一次状态日期快照"作为基准条覆盖在当前主视图下方。
  // 不再切换主视图——查看历史版本请使用版本面板中的"查看"按钮。
  const handleToggleCompareLock = useCallback(async () => {
    if (comparison) {
      dispatch(clearComparison())
      return
    }
    const snapshots = versions.filter(v => !v.is_autosave && v.status_date)
    if (snapshots.length === 0) {
      alert('还没有带状态日期的快照可供对比')
      return
    }
    const baseline = snapshots.length >= 2 ? snapshots[1] : snapshots[0]
    try {
      const r = await authFetch(`/api/versions/${projectId}?id=${baseline.id}`)
      const d = await r.json()
      if (d.ok && d.value?.snapshot?.tasks) {
        dispatch(setComparison({
          tasks: d.value.snapshot.tasks,
          versionName: baseline.name || baseline.status_date?.split('T')[0] || `快照 #${baseline.version_number}`,
        }))
      }
      onShowComparison?.()
    } catch { /* ignore */ }
  }, [comparison, versions, projectId, dispatch, onShowComparison])
  // 区分主动/被动变更：
  // - 添加/删除 → 主动
  // - 添加/删除 → 主动
  // - 仅顺序（order_index）变化 → 被动，自动填「由于 {主动项} 调整引发」
  // - 字段变更且该任务存在上游依赖（from→to 链中的 from 也在变更集里） → 被动
  // - 字段变更但任务不在 dirtyIds 中（非用户显式编辑） → 被动，自动填「由其他任务调整引发」
  // - 其余字段变更 → 主动
  // - 特例：全部都是顺序变化 → 位移最大的那项视为主动
  const { primaryCodes, passiveReasonMap } = React.useMemo(() => {
    const idByCode = new Map<string, string>()
    const codeById = new Map<string, string>()
    for (const t of tasks) {
      idByCode.set(t.task_code, t.id)
      codeById.set(t.id, t.task_code)
    }

    // dirtyIds 中的 task_code 集合——用户显式编辑过的任务
    const dirtyCodeSet = new Set<string>()
    for (const id of dirtyIds) {
      const code = codeById.get(id)
      if (code) dirtyCodeSet.add(code)
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
      if (changedPredsOf(code).length === 0) continue
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

    // 非 dirtyIds 中的字段变更 → 被动（用户未显式编辑，属于间接影响）
    const indirectReason: Record<string, string> = {}
    for (const code of fieldChangedCodes) {
      if (cascadeReason[code]) continue          // 已由依赖链标记
      if (dirtyCodeSet.has(code)) continue        // 用户显式编辑过
      // 找出用户显式编辑的 task_code 作为归因来源
      const dirtyCodes = Array.from(dirtyCodeSet).filter(c => fieldChangedCodes.has(c) || addedRemoved.has(c))
      indirectReason[code] = dirtyCodes.length > 0
        ? `由 ${dirtyCodes.join(', ')} 的调整引发`
        : '由其他任务调整引发'
    }

    const primary = new Set<string>()
    for (const c of addedRemoved) primary.add(c)
    for (const c of fieldChangedCodes) {
      if (!cascadeReason[c] && !indirectReason[c]) primary.add(c)
    }

    const passive: Record<string, string> = { ...cascadeReason, ...indirectReason }
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
  }, [changeDiffs, tasks, dependencies, dirtyIds])

  const openReview = useCallback(() => {
    // 用自动描述预填主动变更的原因
    const prefilled: Record<string, string> = {}
    for (const [taskId, desc] of Object.entries(editDescriptions)) {
      const t = tasks.find(t => t.id === taskId)
      if (t && primaryCodes.has(t.task_code)) {
        prefilled[t.task_code] = desc
      }
    }
    setReasons(prefilled)
    setReviewOpen(true)
  }, [editDescriptions, tasks, primaryCodes])
  const allReasonsFilled = (changeDiffs.length > 0 || depDiff.total > 0) &&
    changeDiffs.every(d => !primaryCodes.has(d.task_code) || (reasons[d.task_code] ?? '').trim().length > 0)

  // 初始加载时，拉取版本列表
  useEffect(() => {
    authFetch(`/api/versions/${projectId}?list=1`)
      .then(r => r.json())
      .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
      .catch(() => {})
  }, [projectId, dispatch])

  // ── 自动保存快照（5 分钟间隔，仅在有未保存编辑时触发） ──
  useEffect(() => {
    if (readOnly) return
    const timer = setInterval(() => {
      if (dirtyIds.length === 0) return
      authFetch(`/api/versions/${projectId}`, {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ tasks, dependencies, is_autosave: true }),
      })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            // 刷新版本列表
            authFetch(`/api/versions/${projectId}?list=1`)
              .then(r => r.json())
              .then(d2 => { if (d2.ok && Array.isArray(d2.value)) dispatch(setVersions(d2.value)) })
          }
        })
        .catch(() => {})
    }, 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [projectId, readOnly, dirtyIds, tasks, dependencies, dispatch])

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

  // 加载上期状态日期快照（用于导出时识别新任务 + 延期归因）
  const [prevSnapshotMap, setPrevSnapshotMap] = useState<{ ids: Set<string>; ends: Map<string, string> }>({ ids: new Set(), ends: new Map() })
  useEffect(() => {
    const snapshots = versions.filter(v => !v.is_autosave && v.status_date)
    const baseline = snapshots.length >= 2 ? snapshots[1] : snapshots[0]
    if (!baseline) { setPrevSnapshotMap({ ids: new Set(), ends: new Map() }); return }
    let cancelled = false
    authFetch(`/api/versions/${projectId}?id=${baseline.id}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.ok && Array.isArray(d.value?.snapshot?.tasks)) {
          const ids = new Set<string>()
          const ends = new Map<string, string>()
          for (const t of d.value.snapshot.tasks as { id: string; end_date: string | null }[]) {
            ids.add(t.id)
            if (t.end_date) ends.set(t.id, String(t.end_date).split('T')[0])
          }
          setPrevSnapshotMap({ ids, ends })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, versions])

  const handleExportExcel = useCallback(() => {
    exportToExcel(tasks, dependencies, currentProject?.name ?? '甘特图', currentProject?.status_date, projectLines, {
      prevTaskIds: prevSnapshotMap.ids,
      prevEndMap: prevSnapshotMap.ends,
    })
    setExportDropdown(false)
  }, [tasks, dependencies, currentProject, projectLines, prevSnapshotMap])

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
      const safeDateRe = /^\d{4}-\d{2}-\d{2}$/
      const safeTasks = parsed.tasks.map((t: ImportTask) => ({
        ...t,
        start_date: typeof t.start_date === 'string' && safeDateRe.test(t.start_date) ? t.start_date : null,
        end_date: typeof t.end_date === 'string' && safeDateRe.test(t.end_date) ? t.end_date : null,
      }))

      // 客户端构建任务/依赖（保存版本时统一落库）
      const codeToId = new Map<string, string>()
      const baseOrder = mode === 'merge' ? tasks.reduce((m, t) => Math.max(m, t.order_index), -1) + 1 : 0

      // 合并模式下，先按 task_code 匹配现有任务（用于覆盖更新而非新建）
      const existingByCode = new Map<string, Task>()
      if (mode === 'merge') for (const t of tasks) existingByCode.set(t.task_code, t)

      // 第一遍：分配 ID
      for (const it of safeTasks) {
        const existing = existingByCode.get(it.task_code)
        if (existing) codeToId.set(it.task_code, existing.id)
        else codeToId.set(it.task_code, uuid())
      }

      const importedTasks: Task[] = safeTasks.map((it, i) => {
        const id = codeToId.get(it.task_code)!
        const parent = it.parent_task_code ? codeToId.get(it.parent_task_code) ?? null : null
        const existing = existingByCode.get(it.task_code)
        return {
          id, project_id: projectId, task_code: it.task_code,
          name: it.name,
          parent_id: parent,
          assignee: it.assignee,
          start_date: it.start_date, end_date: it.end_date,
          duration: it.duration ?? 0, duration_unit: 'day',
          percent_done: it.percent_done ?? 0,
          is_milestone: it.is_milestone,
          note: it.note,
          order_index: existing?.order_index ?? (baseOrder + i),
          auto_schedule: it.auto_schedule,
          constraint_type: it.constraint_type ?? 'asap',
          constraint_date: it.constraint_date ?? null,
          status: it.status ?? null,
          rollup: it.rollup ?? false,
          inactive: it.inactive ?? false,
          project_boundary: it.project_boundary ?? 'ask',
          baseline_end_date: it.baseline_end_date ?? null,
          original_start_date: null,
          original_end_date: null,
          deadline: it.deadline ?? null,
          is_deleted: false,
          deleted_at: null,
          created_at: existing?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      })

      const importedDeps: Dependency[] = []
      for (const d of parsed.dependencies as ImportDep[]) {
        const fromId = codeToId.get(d.from_task_code)
        const toId = codeToId.get(d.to_task_code)
        if (!fromId || !toId) continue
        importedDeps.push({
          id: uuid(),
          project_id: projectId,
          from_task_id: fromId,
          to_task_id: toId,
          type: d.type, lag: d.lag,
          active: d.active ?? true,
        })
      }

      let nextTasks: Task[]
      let nextDeps: Dependency[]
      if (mode === 'replace') {
        nextTasks = importedTasks
        nextDeps = importedDeps
      } else {
        // merge：保留未在 Excel 中出现的现有任务
        const importedIds = new Set(importedTasks.map(t => t.id))
        const keptTasks = tasks.filter(t => !importedIds.has(t.id))
        nextTasks = [...keptTasks, ...importedTasks]
        nextDeps = [...dependencies, ...importedDeps]
      }

      dispatch(setTasks({ tasks: nextTasks, dependencies: nextDeps }))
      dispatch(markDirty(nextTasks.map(t => t.id)))

      if (parsed.statusDate) {
        dispatch(setStatusDate({ projectId, statusDate: parsed.statusDate }))
      }
      if (parsed.projectLines) {
        const lines = parsed.projectLines.map((l: ImportProjectLine) => ({
          id: uuid(),
          project_id: projectId,
          name: l.name,
          line_date: l.line_date,
          color: l.color,
          visible: l.visible,
        }))
        dispatch(setProjectLines(lines))
      }
      alert(`导入成功！${nextTasks.length} 个任务、${nextDeps.length} 条依赖已加载到本地，"保存版本"时入库。`)
    } catch (err) {
      alert(`解析 Excel 文件失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setImporting(false)
    }
  }, [dispatch, projectId, tasks, dependencies])

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

  // ── Create task（本地，保存版本时入库）────────────────────────────────
  const handleAddTask = useCallback(() => {
    const fmtD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const statusDateStr = currentProject?.status_date?.split('T')[0] ?? null
    const startD = statusDateStr ? new Date(statusDateStr + 'T00:00:00') : new Date()
    startD.setHours(0, 0, 0, 0)
    const startStr = fmtD(startD)
    const endD = new Date(startD); endD.setDate(endD.getDate() + 1)
    const endStr = fmtD(endD)

    const rootTasks = tasks.filter(t => t.parent_id === null)
    const nextIndex = rootTasks.length > 0 ? Math.max(...rootTasks.map(t => t.order_index)) + 1 : 0
    const maxCode = tasks.reduce((m, t) => {
      const n = parseInt(t.task_code, 10)
      return !isNaN(n) && n > m ? n : m
    }, 0)
    const newTask: Task = {
      id: uuid(),
      project_id: projectId,
      task_code: String(maxCode + 1),
      name: 'New Task',
      parent_id: null,
      assignee: null,
      start_date: startStr, end_date: endStr,
      duration: 1, duration_unit: 'day',
      percent_done: 0, is_milestone: false, note: null,
      order_index: nextIndex,
      auto_schedule: true,
      constraint_type: 'asap',
      constraint_date: null,
      status: null,
      rollup: false,
      inactive: false,
      project_boundary: 'ask',
      baseline_end_date: null,
      original_start_date: null,
      original_end_date: null,
      deadline: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    dispatch(addTasks([newTask]))
    dispatch(markDirty([newTask.id]))
    dispatch(setSelectedIds([newTask.id]))
  }, [dispatch, projectId, tasks, currentProject])

  // ── Delete（本地）────────────────────────────────────────────────────────
  const handleDeleteTasks = useCallback(() => {
    if (!hasSelection) return
    if (!confirm(`确定删除 ${selectedIds.length} 个任务？`)) return
    // 同时移除关联依赖
    const ids = new Set(selectedIds)
    const relatedDeps = dependencies.filter(d => ids.has(d.from_task_id) || ids.has(d.to_task_id))
    for (const d of relatedDeps) dispatch(removeDependency(d.id))
    dispatch(deleteTasks(selectedIds))
    const remainDeps = dependencies.filter(d => !relatedDeps.some(x => x.id === d.id))
    const remainTasks = tasks.filter(t => !ids.has(t.id))
    const cascaded = runFullCascade(remainTasks, remainDeps)
    if (cascaded.length > 0) {
      dispatch(updateTasks(cascaded))
      dispatch(markDirty(cascaded.map(t => t.id)))
    }
  }, [dispatch, selectedIds, hasSelection, tasks, dependencies])

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


    // 升级时删除被升级任务与旧父任务之间的依赖关系（本地）
    const promotedIds = new Set(toPromote.map(t => t.id))
    const oldParentIdsForDeps = new Set(toPromote.map(t => t.parent_id!))
    const depsToRemove = dependencies.filter(d =>
      (promotedIds.has(d.from_task_id) && oldParentIdsForDeps.has(d.to_task_id)) ||
      (promotedIds.has(d.to_task_id) && oldParentIdsForDeps.has(d.from_task_id))
    )
    for (const dep of depsToRemove) dispatch(removeDependency(dep.id))

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


    // 降级时：删除被降级任务与新父任务之间的依赖（本地）
    const demotedIds = new Set(allUpdates.map(u => u.id))
    const newParentIds = new Set(allUpdates.map(u => u.parent_id).filter(Boolean) as string[])
    const depsToRemove = dependencies.filter(d =>
      (demotedIds.has(d.from_task_id) && newParentIds.has(d.to_task_id)) ||
      (demotedIds.has(d.to_task_id) && newParentIds.has(d.from_task_id)) ||
      newParentIds.has(d.from_task_id) || newParentIds.has(d.to_task_id)
    )
    for (const dep of depsToRemove) dispatch(removeDependency(dep.id))

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
          const shiftedTasks = shiftPayload.map(p => {
            const orig = tasks.find(t => t.id === p.id)!
            return { ...orig, order_index: p.order_index }
          })
          dispatch(updateTasks(shiftedTasks))
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
    const idMap = new Map<string, string>()
    const maxCode = tasks.reduce((m, t) => {
      const n = parseInt(t.task_code, 10)
      return !isNaN(n) && n > m ? n : m
    }, 0)
    const pastedTasks: Task[] = clipboard.map((t, i) => {
      const newId = uuid()
      idMap.set(t.id, newId)
      return {
        ...t,
        id: newId,
        task_code: String(maxCode + 1 + i),
        name: `${t.name} (copy)`,
        parent_id: t.parent_id && clipIds.has(t.parent_id) ? t.parent_id : insertParentId,
        order_index: insertOrderBase + i,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Task
    })
    // 将引用旧 ID 的 parent_id 替换为新 ID
    for (const pt of pastedTasks) {
      if (pt.parent_id && idMap.has(pt.parent_id)) pt.parent_id = idMap.get(pt.parent_id)!
    }
    dispatch(addTasks(pastedTasks))
    dispatch(markDirty(pastedTasks.map(t => t.id)))
    dispatch(setSelectedIds(pastedTasks.map(t => t.id)))

    // 复制依赖
    if (clipboardDeps.length > 0) {
      const newDeps: Dependency[] = []
      for (const dep of clipboardDeps) {
        const newFrom = idMap.get(dep.from_task_id)
        const newTo = idMap.get(dep.to_task_id)
        if (!newFrom || !newTo) continue
        const newDep: Dependency = {
          id: uuid(),
          project_id: projectId,
          from_task_id: newFrom,
          to_task_id: newTo,
          type: dep.type,
          lag: dep.lag,
          active: dep.active ?? true,
        }
        newDeps.push(newDep)
        dispatch(addDependency(newDep))
      }
      const cascaded = runFullCascade(
        [...tasks, ...pastedTasks],
        [...dependencies, ...newDeps],
      )
      if (cascaded.length > 0) {
        dispatch(updateTasks(cascaded))
        dispatch(markDirty(cascaded.map(t => t.id)))
      }
    }
    requestAnimationFrame(() => onFocusTask())
  }, [dispatch, projectId, clipboard, clipboardDeps, onFocusTask, tasks, dependencies])

  // ── Status date: free movement + separate confirm button ────────
  const [statusDateSaving, setStatusDateSaving] = useState(false)

  // 自由移动状态日期（仅更新 Redux + 后端，不创建版本）
  // 允许任意历史日期以便查看进展；保存版本时再做合规校验
  const handleStatusDatePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value || null
    dispatch(setStatusDate({ projectId, statusDate: val }))
    await authFetch(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ status_date: val }),
    })
  }, [dispatch, projectId])

  // 确认变更：批量落库本地编辑 + 重算完成度 + 创建版本快照
  const handleConfirmChanges = useCallback(async () => {
    const sd = toDateTimeStr(currentProject?.status_date ?? null)
    if (!sd || statusDateSaving) return

    // 保存时校验状态日期：1) 不晚于当前时刻 2) 不早于 72 小时前 3) 严格大于上一版本
    const nowStr = toDateTimeStr(new Date())!
    if (sd > nowStr) {
      alert(`无法保存：状态日期 ${sd.slice(0, 16).replace('T', ' ')} 晚于当前时间 (${nowStr.slice(0, 16).replace('T', ' ')})`)
      return
    }
    const earliestStr = addMinutesStr(nowStr, -3 * 24 * 60)!
    if (sd < earliestStr) {
      alert(`无法保存：状态日期 ${sd.slice(0, 16).replace('T', ' ')} 早于 ${earliestStr.slice(0, 16).replace('T', ' ')}（仅允许最近 72 小时内）`)
      return
    }
    if (lastVersionDate && sd <= lastVersionDate) {
      alert(`无法保存：状态日期必须晚于上一版本 (${lastVersionDate.slice(0, 16).replace('T', ' ')})`)
      return
    }

    setStatusDateSaving(true)

    // 1. 重算 percent_done + baseline_end_date（基于上一版本快照）
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
    const recomputed = tasks
      .filter(t => t.start_date && t.end_date)
      .map(t => {
        const prevEnd = prevEndByTaskId.get(t.id) ?? null
        const baselineEnd = prevEnd ?? ((t.end_date ?? '').split('T')[0] || null)
        return {
          ...t,
          percent_done: calcPercent(t, sdDate),
          baseline_end_date: baselineEnd,
        }
      })
    if (recomputed.length > 0) dispatch(updateTasks(recomputed))
    // 用 recomputed 后的状态作为本次保存的快照
    const finalTasks = tasks.map(t => recomputed.find(u => u.id === t.id) ?? t)

    // 2. 与基线 diff，生成批量操作
    const diff = buildSaveDiff(baselineTasks, baselineDeps, finalTasks, dependencies)
    let saveError: string | null = null
    try {
      // 删除依赖必须先于删除任务，避免外键级联删除丢失审计
      for (const depId of diff.depsToDelete) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'DELETE', headers: authFetchHeaders(true),
          body: JSON.stringify({ id: depId }),
        })
        if (!r.ok) throw new Error(`删除依赖失败 (${r.status})`)
      }
      // 删除任务
      if (diff.tasksToDelete.length > 0) {
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'DELETE', headers: authFetchHeaders(true),
          body: JSON.stringify({ ids: diff.tasksToDelete }),
        })
        if (!r.ok) throw new Error(`删除任务失败 (${r.status})`)
      }
      // 新增任务（连同 client id / task_code）
      if (diff.tasksToAdd.length > 0) {
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'POST', headers: authFetchHeaders(true),
          body: JSON.stringify(diff.tasksToAdd),
        })
        if (!r.ok) throw new Error(`新增任务失败 (${r.status})`)
      }
      // 更新任务
      if (diff.tasksToUpdate.length > 0) {
        const payload = diff.tasksToUpdate.map(t => ({
          id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, percent_done: t.percent_done, parent_id: t.parent_id,
          order_index: t.order_index, is_milestone: t.is_milestone, auto_schedule: t.auto_schedule,
          assignee: t.assignee, note: t.note,
          constraint_type: t.constraint_type, constraint_date: t.constraint_date,
          status: t.status, deadline: t.deadline,
          rollup: t.rollup, inactive: t.inactive, project_boundary: t.project_boundary,
          baseline_end_date: t.baseline_end_date, task_code: t.task_code,
        }))
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'PUT', headers: authFetchHeaders(true),
          body: JSON.stringify(payload),
        })
        if (!r.ok) throw new Error(`更新任务失败 (${r.status})`)
      }
      // 新增依赖
      for (const dep of diff.depsToAdd) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'POST', headers: authFetchHeaders(true),
          body: JSON.stringify({
            id: dep.id, from_task_id: dep.from_task_id, to_task_id: dep.to_task_id,
            type: dep.type, lag: dep.lag, active: dep.active ?? true,
          }),
        })
        if (!r.ok) throw new Error(`新增依赖失败 (${r.status})`)
      }
      // 更新依赖
      for (const dep of diff.depsToUpdate) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'PUT', headers: authFetchHeaders(true),
          body: JSON.stringify({ id: dep.id, type: dep.type, lag: dep.lag, active: dep.active ?? true }),
        })
        if (!r.ok) throw new Error(`更新依赖失败 (${r.status})`)
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    }

    if (saveError) {
      setStatusDateSaving(false)
      alert(`保存失败：${saveError}`)
      return
    }

    // 3. 创建版本快照
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
        tasks: finalTasks, dependencies,
        status_date: sd,
        reasons: reasonMap,
      }),
    })
    const snapshotData = await snapshotRes.json()

    setStatusDateSaving(false)

    if (snapshotData.ok) {
      dispatch(clearDirty())
      // 重置基线为已落库的当前状态
      const livingTasks = finalTasks.filter(t => !t.is_deleted)
      setBaseline(livingTasks.map(t => ({
        id: t.id, task_code: t.task_code, name: t.name,
        start_date: t.start_date, end_date: t.end_date,
        duration: t.duration, assignee: t.assignee,
        percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
        parent_id: t.parent_id,
      })))
      setBaselineTasks(livingTasks.map(t => ({ ...t })))
      setBaselineDeps(dependencies.map(d => ({ ...d })))

      authFetch(`/api/versions/${projectId}?list=1`)
        .then(r => r.json())
        .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
        .catch(() => {})
    } else {
      alert(`版本保存失败：${snapshotData.error ?? '未知错误'}`)
    }
  }, [currentProject, statusDateSaving, dispatch, projectId, tasks, dependencies,
      changeDiffs, versions, reasons, primaryCodes, passiveReasonMap,
      baselineTasks, baselineDeps, lastVersionDate])

  // ── 放弃更改：重新加载 DB 状态（所有本地编辑被丢弃，因为它们从未入库）
  const handleRefresh = useCallback(async () => {
    try {
      const res = await authFetch(`/api/tasks/${projectId}`)
      const data = await res.json()
      if (data.ok && data.value) {
        const freshTasks = Array.isArray(data.value.tasks) ? data.value.tasks : []
        const freshDeps = Array.isArray(data.value.dependencies) ? data.value.dependencies : []
        dispatch(setTasks({ tasks: freshTasks, dependencies: freshDeps }))
        dispatch(clearDirty())
        dispatch(clearComparison())
        const livingTasks = freshTasks.filter((t: Task) => !t.is_deleted)
        setBaseline(livingTasks.map((t: Task) => ({
          id: t.id, task_code: t.task_code, name: t.name,
          start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, assignee: t.assignee,
          percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
          parent_id: t.parent_id,
        })))
        setBaselineTasks(livingTasks.map((t: Task) => ({ ...t })))
        setBaselineDeps(freshDeps.map((d: Dependency) => ({ ...d })))
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
                const v = currentProject?.status_date ?? ''
                return (
                  <YmdDateInput value={v} onChange={handleStatusDatePick} includeTime={isMinute} />
                )
              })()}
              {(() => {
                const sd = toDateTimeStr(currentProject?.status_date ?? null)
                const nowStr = toDateTimeStr(new Date())!
                const isFuture = !!sd && sd > nowStr
                const canSubmit = !!sd && !statusDateSaving && !isFuture && hasChanges
                const tip = !sd
                  ? '请先设置状态日期'
                  : isFuture ? `状态日期不能晚于当前时间 (${nowStr.slice(0, 16).replace('T', ' ')})`
                  : hasChanges ? '确认变更：保存所有改动并创建版本快照'
                  : '没有变更，无需保存'
                return (
                  <button
                    onClick={() => {
                      if (!sd) { alert('请先设置状态日期'); return }
                      if (sd > nowStr) {
                        alert(`状态日期不能晚于当前时间 (${nowStr.slice(0, 16).replace('T', ' ')})`); return
                      }
                      if (lastVersionDate && sd < lastVersionDate) {
                        alert(`状态日期不能早于上一版本 (${lastVersionDate.slice(0, 16).replace('T', ' ')})`); return
                      }
                      openReview()
                    }}
                    disabled={!canSubmit}
                    title={tip}
                    className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                      ${canSubmit
                        ? 'border-green-500 text-green-700 bg-green-50 hover:bg-green-100 cursor-pointer'
                        : 'border-gray-200 text-gray-300 bg-gray-50 cursor-not-allowed'}`}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {statusDateSaving ? '保存中...' : '确认变更'}
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
                title={comparison ? `退出对比模式（当前对比：${comparison.versionName}）` : '进入对比模式，默认对比最近 2 次状态日期快照；可在历史版本面板切换对比目标'}
                className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                  ${comparison
                    ? 'border-orange-500 text-orange-700 bg-orange-50 hover:bg-orange-100 cursor-pointer'
                    : 'border-gray-300 text-gray-600 bg-white hover:bg-gray-50 cursor-pointer'}`}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="8" cy="8" r="2.5"/>
                </svg>
                {comparison ? '退出对比' : '对比模式'}
              </button>
              <div ref={viewVersionRef} className="relative">
                <button
                  onClick={() => {
                    if (viewSnapshot) { dispatch(clearViewSnapshot()); return }
                    setViewVersionOpen(v => !v)
                  }}
                  title={viewSnapshot ? `退出查看历史版本「${viewSnapshot.versionName}」` : '查看历史版本（只读，状态/延期回到当时）'}
                  className={`inline-flex items-center gap-1 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
                    ${viewSnapshot
                      ? 'border-amber-500 text-amber-700 bg-amber-50 hover:bg-amber-100 cursor-pointer'
                      : 'border-gray-300 text-gray-600 bg-white hover:bg-gray-50 cursor-pointer'}`}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M8 3v5l3 2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 8a6 6 0 1 0 2-4.5" strokeLinecap="round"/>
                    <path d="M2 2v3h3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {viewSnapshot ? `查看中: ${viewSnapshot.versionName}` : '查看历史'}
                </button>
                {viewVersionOpen && !viewSnapshot && (
                  <div className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-xl py-1 min-w-[200px] max-h-[320px] overflow-y-auto">
                    {versions.filter(v => !v.is_autosave).length === 0 && (
                      <div className="px-3 py-3 text-[12px] text-gray-400 text-center">暂无历史版本</div>
                    )}
                    {versions.filter(v => !v.is_autosave).map(v => {
                      const label = v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`
                      const sd = v.status_date ? String(v.status_date).split('T')[0] : null
                      return (
                        <button
                          key={v.id}
                          onClick={() => handleEnterViewSnapshot(v.id)}
                          className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-amber-50 hover:text-amber-700 flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <span className="font-medium truncate">{label}</span>
                          {sd && <span className="text-[10px] text-gray-400 shrink-0">{sd}</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
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
              value={currentProject?.status_date ?? ''}
              onChange={handleStatusDatePick}
              includeTime={isMinute}
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
              <span className="text-[11px] text-orange-700 font-semibold">当前</span>
              <span className="text-orange-400">vs</span>
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
              onClick={() => dispatch(clearComparison())}
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
                    {depDiff.total > 0 && (
                      <span className="text-purple-600">
                        依赖 {depDiff.added > 0 ? `+${depDiff.added} ` : ''}{depDiff.updated > 0 ? `~${depDiff.updated} ` : ''}{depDiff.removed > 0 ? `-${depDiff.removed}` : ''}
                      </span>
                    )}
                    <span className="text-gray-400 ml-auto">共 {changeDiffs.length + depDiff.total} 项变更</span>
                  </>
                )
              })()}
            </div>

            {/* Diff list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
              {changeDiffs.length === 0 && depDiff.total === 0 && (
                <div className="text-center text-gray-400 py-8 text-sm">没有检测到变更</div>
              )}
              {changeDiffs.map((d, i) => (
                <div key={`task-${i}`} className={`rounded border px-3 py-2 text-[13px] ${
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
              ))}
              {depDiff.items.map(item => (
                <div key={`dep-${item.id}`} className={`rounded border px-3 py-2 text-[13px] ${
                  item.type === 'added' ? 'border-green-200 bg-green-50'
                  : item.type === 'removed' ? 'border-red-200 bg-red-50'
                  : 'border-blue-200 bg-blue-50'
                }`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${
                      item.type === 'added' ? 'bg-green-200 text-green-800'
                      : item.type === 'removed' ? 'bg-red-200 text-red-800'
                      : 'bg-blue-200 text-blue-800'
                    }`}>
                      依赖{item.type === 'added' ? '新增' : item.type === 'removed' ? '删除' : '修改'}
                    </span>
                    <span className="inline-block px-1.5 py-0.5 rounded text-[11px] font-mono bg-gray-100 text-gray-600 border border-gray-200">
                      {item.depTypeLabel}
                    </span>
                    <span className="text-gray-700">
                      <span className="text-gray-400 text-xs">{item.fromCode}</span>{' '}
                      <span className="font-medium">{item.fromName}</span>
                      <span className="mx-1.5 text-gray-400">→</span>
                      <span className="text-gray-400 text-xs">{item.toCode}</span>{' '}
                      <span className="font-medium">{item.toName}</span>
                    </span>
                  </div>
                  {item.changes && item.changes.length > 0 && (
                    <div className="mt-1.5 space-y-0.5 pl-2 border-l-2 border-blue-200">
                      {item.changes.map((c, j) => (
                        <div key={j} className="text-xs text-gray-600">
                          <span className="text-gray-400">{c.field}:</span>{' '}
                          <span className="line-through text-red-500/70">{c.old}</span>
                          {' → '}
                          <span className="text-green-700">{c.new}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
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
