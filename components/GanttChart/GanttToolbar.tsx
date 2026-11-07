'use client'

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '@/store'
import { undoDraft, redoDraft, beginDraftSave, finishDraftSave, failDraftSave, resetDraft, labelDraftStep, linesEqual, hasDraftChanges } from '@/store/draftHistory'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  copyTasks, addTasks, deleteTasks, updateTasks, addDependency, removeDependency,
  setSelectedIds, setTasks,
  markDirty, setComparison, clearComparison, setViewSnapshot, clearViewSnapshot, clearDiffFilter,
} from '@/store/slices/tasksSlice'
import { setStatusDate, setPlanningStatus } from '@/store/slices/projectSlice'
import { customFieldsEqual, CUSTOM_FIELD_TYPES, mergeTaskAttributes, taskCustomFields } from '@/lib/taskCustomFields'
import GanttDisplaySettings from './GanttDisplaySettings'
import ToolbarActionMenu from './ToolbarActionMenu'
import { normalizePlanningStatus, planningStatusLabel, changeReasonsComplete } from '@/lib/planningStatus'
import { setVersions } from '@/store/slices/versionsSlice'
import type { Task, TaskCustomField } from '@/types'
import EditTaskModal from './EditTaskModal'
import TaskCustomFieldsPanel from './TaskCustomFieldsPanel'
import BulkEditPanel from './BulkEditPanel'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { addMinutesStr, toDateTimeStr } from '@/lib/clientTime'
import { scheduleDurationMinutes } from '@/lib/clientTaskEdit'
import YmdDateInput from '@/components/YmdDateInput'
import { exportToExcel } from '@/lib/client/excelExport'
import { exportToJpeg, exportToPdf } from '@/lib/client/chartExport'
import { parseExcelFile, validateImportData, type ImportTask, type ImportDep, type ImportProjectLine } from '@/lib/client/excelImport'
import { setProjectLines } from '@/store/slices/projectLinesSlice'
import type { OptionalCol, IndicatorsConfig } from './GanttChart'
import VersionPanel from './VersionPanel'
import RetroLogPanel from './RetroLogPanel'
import { diffSnapshots, type SnapshotTask, type DiffItem } from '@/lib/versionDiff'
import { runFullCascade, collapseDeletedTaskSuccessors } from '@/lib/clientScheduling'
import { buildSaveDiff, recoverSaveRecords, type SaveBaseline } from '@/lib/clientSave'
import { uuid } from '@/lib/uuid'
import { buildTaskCopies } from '@/lib/clientTaskCopy'
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
const LabelIc = ({ icon, label, title, onClick, disabled, variant = 'default' }: {
  icon: React.ReactNode; label: string; title?: string
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
    <button className={`${base} ${colors[variant]} whitespace-nowrap`} title={title ?? label}
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
const IcoZoomIn  = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3M6.5 5v3" strokeLinecap="round"/></svg>
const IcoZoomOut = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3" strokeLinecap="round"/></svg>
const IcoSearch  = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5" strokeLinecap="round"/></svg>
const IcoRefresh = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 8a6 6 0 0 0-10-4.5M2 8a6 6 0 0 1 10 4.5" strokeLinecap="round"/><path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoDownload = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoUpload   = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 10V2M5 5l3-3 3 3M3 12h10" strokeLinecap="round" strokeLinejoin="round"/></svg>

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through for HTTP or denied clipboard permission */ }
  }

  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { /* manual copy below */ }
  document.body.removeChild(input)
  return copied
}

// YmdDateInput 提取到 components/YmdDateInput.tsx 复用

// ── Props ─────────────────────────────────────────────────────────────────
interface GanttToolbarProps {
  projectId: string
  initialBaseline: SaveBaseline
  readOnly?: boolean
  isMinute?: boolean  // 项目精度：true=分钟级，false=天级
  colW: number
  onZoomIn: () => void
  onZoomOut: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onFocusTask: () => void
  onTimelineNavigate?: (kind: 'all' | 'selection' | 'status') => void
  viewControls?: React.ReactNode
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
  onDiscardChanges?: () => void
}

export default function GanttToolbar({
  projectId,
  initialBaseline,
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
  onDiscardChanges,
  onTimelineNavigate, viewControls,
}: GanttToolbarProps) {
  const dispatch = useAppDispatch()
  const reduxStore = useStore<RootState>()
  const { selectedIds, clipboard, clipboardDeps, tasks, dependencies, dirtyIds, comparison, viewSnapshot, diffFilter } = useAppSelector(s => s.tasks)
  const currentProject = useAppSelector(s => s.project.currentProject)
  const history = useAppSelector(s => s.draft)
  const draftChanged = useAppSelector(hasDraftChanges)
  const projectLines = useAppSelector(s => s.projectLines.lines)
  const { versions } = useAppSelector(s => s.versions)
  const formatStatusDate = useCallback((value?: string | Date | null) => {
    const dt = toDateTimeStr(value ?? null)
    if (!dt) return ''
    return isMinute ? dt.slice(0, 16).replace('T', ' ') : dt.slice(0, 10)
  }, [isMinute])
  const versionLabel = useCallback((v: { name?: string | null; status_date?: string | null; version_number: number }) => (
    v.name || formatStatusDate(v.status_date) || `快照 #${v.version_number}`
  ), [formatStatusDate])
  const snapshotEndForBaseline = useCallback((value?: string | null) => {
    const dt = toDateTimeStr(value ?? null)
    if (!dt) return null
    return isMinute ? dt : dt.slice(0, 10)
  }, [isMinute])
  const statusDateRange = React.useMemo(() => {
    if (!isMinute) return { min: undefined, max: undefined }
    const firstTask = getFlatOrder(tasks).find(t => t.start_date)
    const min = toDateTimeStr(firstTask?.start_date ?? null)?.slice(0, 16)
    return {
      min,
      max: min ? addMinutesStr(min, 24 * 60)?.slice(0, 16) : undefined,
    }
  }, [isMinute, tasks])
  const normalizeStatusDate = useCallback((value: string | null) => {
    if (!value) return null
    const normalized = isMinute
      ? toDateTimeStr(value)?.slice(0, 16)
      : value.slice(0, 10)
    return normalized ?? null
  }, [isMinute])

  const [attributeViewTask, setAttributeViewTask] = useState<Task | null>(null)
  const hasSelection = selectedIds.length > 0


  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)
  const [retroLogOpen, setRetroLogOpen] = useState(false)
  const [viewVersionOpen, setViewVersionOpen] = useState(false)
  const zoomMin = isMinute ? 24 : 3
  const zoomMax = isMinute ? 2880 : 56
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
          lines: d.value.snapshot.lines,
          planningStatus: normalizePlanningStatus(d.value.snapshot.planning_status),
          customFields: d.value.snapshot.custom_fields,
          versionId: v.id,
          versionName: versionLabel(v),
        }))
      }
    } catch { /* ignore */ }
    setViewVersionOpen(false)
  }, [versions, projectId, dispatch, versionLabel])

  // ── 变更检测（纯本地，不依赖 API）──────────────────────────────────
  // 基线：首次加载任务时捕获快照，作为"上次入库状态"。所有编辑只改 Redux，
  // "保存版本"时与基线 diff 出增删改，批量落库后基线重置为当前状态。
  const [baseline, setBaseline] = useState<SnapshotTask[] | null>(() => initialBaseline.tasks.map(t => ({ ...t })))
  const [baselineTasks, setBaselineTasks] = useState<Task[]>(() => initialBaseline.tasks.map(t => ({ ...t })))
  const [baselineDeps, setBaselineDeps] = useState<Dependency[]>(() => initialBaseline.dependencies.map(d => ({ ...d })))
  // 状态日期同样进入"待确认"流程：捕获原始值，确认变更时落库，放弃更改时回滚。
  const [baselineStatusDate, setBaselineStatusDate] = useState<string | null>(initialBaseline.statusDate)
  const [baselinePlanningStatus, setBaselinePlanningStatus] = useState(() => normalizePlanningStatus(initialBaseline.planningStatus))
  const [baselineCustomFields, setBaselineCustomFields] = useState(initialBaseline.customFields ?? [])
  const [customFieldsReason, setCustomFieldsReason] = useState('')
  const customFields = currentProject?.custom_fields ?? []
  const customFieldsChanged = !customFieldsEqual(baselineCustomFields, customFields)
  const planningStatus = normalizePlanningStatus(currentProject?.planning_status)
  const displayedPlanningStatus = viewSnapshot ? normalizePlanningStatus(viewSnapshot.planningStatus) : planningStatus
  const reasonsRequired = planningStatus === 'stable'
  const planningStatusChanged = planningStatus !== baselinePlanningStatus
  const [baselineLines, setBaselineLines] = useState(initialBaseline.lines ?? [])
  const attemptedLineIds = useRef(new Set<string>())
  const [saveIncomplete, setSaveIncomplete] = useState(false)
  const attemptedSaveIds = useRef({ taskIds: new Set<string>(), dependencyIds: new Set<string>() })

  // changeDiffs: 当前任务 vs 基线
  const changeDiffs = React.useMemo(() => {
    if (!baseline) return [] as DiffItem[]
    const currentSnap: SnapshotTask[] = tasks.filter(t => !t.is_deleted).map(t => ({
      id: t.id, task_code: t.task_code, name: t.name,
      start_date: t.start_date, end_date: t.end_date,
      duration: t.duration, assignee: t.assignee,
      percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
      auto_schedule: t.auto_schedule, note: t.note, custom_fields: t.custom_fields, custom_values: t.custom_values,
      parent_id: t.parent_id,
    }))
    return diffSnapshots(baseline, currentSnap, { isMinute, customFields: currentProject?.custom_fields })
  }, [baseline, tasks, isMinute, currentProject?.custom_fields])

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
    const fmtLag = (lag: number | null | undefined) => (
      isMinute ? `${lag ?? 0}m` : `${Math.round((lag ?? 0) / 1440)}d`
    )

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
        changes.push({ field: '延迟', old: fmtLag(old.lag), new: fmtLag(cur.lag) })
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
  }, [baselineDeps, dependencies, baselineTasks, tasks, isMinute])

  const statusDateChanged = toDateTimeStr(currentProject?.status_date ?? null) !== baselineStatusDate
  const linesChanged = !linesEqual(baselineLines, projectLines)
  const lineDiffs = useMemo(() => {
    const old = new Map(baselineLines.map(line => [line.id, line]))
    const current = new Map(projectLines.map(line => [line.id, line]))
    return [...new Set([...old.keys(), ...current.keys()])].flatMap(id => {
      const before = old.get(id), after = current.get(id)
      return before && after && linesEqual([before], [after]) ? [] : [{ id, before, after }]
    })
  }, [baselineLines, projectLines])
  const hasChanges = draftChanged || saveIncomplete

  // 变更审核弹窗状态
  const [reviewOpen, setReviewOpen] = useState(false)
  // 每个变更项的原因（key = task_code）
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [dependencyReasons, setDependencyReasons] = useState<Record<string, string>>({})

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
          versionName: versionLabel(baseline),
        }))
      }
      onShowComparison?.()
    } catch { /* ignore */ }
  }, [comparison, versions, projectId, dispatch, onShowComparison, versionLabel])
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
    // Reparenting and custom attributes are explicit edits, never dependency cascades.
    for (const diff of changeDiffs) if (diff.changes?.some(c => c.field === '父任务' || c.field.startsWith('属性：'))) {
      primary.add(diff.task_code)
      delete passive[diff.task_code]
    }
    return { primaryCodes: primary, passiveReasonMap: passive }
  }, [changeDiffs, tasks, dependencies, dirtyIds])

  const manualReasonCodes = React.useMemo(() => {
    const currentByCode = new Map(tasks.map(t => [t.task_code, t]))
    const baselineByCode = new Map(baselineTasks.map(t => [t.task_code, t]))
    const codes = new Set<string>()
    for (const d of changeDiffs) {
      const current = currentByCode.get(d.task_code)
      const old = baselineByCode.get(d.task_code)
      if (current?.auto_schedule === false || (d.type === 'removed' && old?.auto_schedule === false)) {
        codes.add(d.task_code)
      }
    }
    return codes
  }, [changeDiffs, tasks, baselineTasks])

  const requiredReasonCodes = React.useMemo(() => {
    const codes = new Set(primaryCodes)
    for (const code of manualReasonCodes) codes.add(code)
    return codes
  }, [primaryCodes, manualReasonCodes])

  const openReview = useCallback(() => {
    setReasons({})
    setDependencyReasons({})
    setCustomFieldsReason('')
    setReviewOpen(true)
  }, [])
  // 有任意变更（任务/依赖/状态日期）即视为可提交；
  // 任务变更里所有主动项需要填理由，纯状态日期变更不需要理由。
  const allReasonsFilled = hasChanges && (!reasonsRequired || !customFieldsChanged || !!customFieldsReason.trim()) && changeReasonsComplete(
    planningStatus, requiredReasonCodes, depDiff.items.map(d => d.id), reasons, dependencyReasons,
  )

  // Opening a project only reads versions; the first version is created by confirmation.
  useEffect(() => {
    let cancelled = false
    authFetch(`/api/versions/${projectId}?list=1`).then(r => r.json()).then(d => {
      if (!cancelled && d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectId, dispatch])

  const [exportDropdown, setExportDropdown] = useState(false)
  const exportDropdownRef = useRef<HTMLDivElement>(null)
  const [importDropdown, setImportDropdown] = useState(false)
  const importDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportDropdown) return
    const close = (e: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) setExportDropdown(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [exportDropdown])

  useEffect(() => {
    if (!importDropdown) return
    const close = (e: MouseEvent) => {
      if (importDropdownRef.current && !importDropdownRef.current.contains(e.target as Node)) setImportDropdown(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [importDropdown])

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
            const end = snapshotEndForBaseline(t.end_date)
            if (end) ends.set(t.id, end)
          }
          setPrevSnapshotMap({ ids, ends })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, versions, snapshotEndForBaseline])

  const handleExportExcel = useCallback(() => {
    exportToExcel(tasks, dependencies, currentProject?.name ?? '甘特图', currentProject?.status_date, projectLines, {
      prevTaskIds: prevSnapshotMap.ids,
      prevEndMap: prevSnapshotMap.ends,
      isMinute,
      customFields: currentProject?.custom_fields,
    })
    setExportDropdown(false)
  }, [tasks, dependencies, currentProject, projectLines, prevSnapshotMap, isMinute])

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

  const handleExportMpp = useCallback(async () => {
    setExportDropdown(false)
    try {
      const idMap = new Map(tasks.map(t => [t.id, t]))
      const codeOf = (id: string | null) => id ? idMap.get(id)?.task_code ?? null : null
      const exportDate = (value: string | null | undefined) => {
        const normalized = toDateTimeStr(value ?? null)
        if (!normalized) return null
        return isMinute ? normalized : normalized.slice(0, 10)
      }
      const payload = {
        name: currentProject?.name ?? 'project',
        start_date: exportDate(currentProject?.start_date),
        end_date: exportDate(currentProject?.end_date),
        status_date: exportDate(currentProject?.status_date),
        time_granularity: isMinute ? 'minute' : 'day',
        custom_fields: currentProject?.custom_fields ?? [],
        project_lines: projectLines,
        tasks: tasks
          .filter(t => !t.is_deleted)
          .map(t => ({
            task_code: t.task_code,
            parent_task_code: codeOf(t.parent_id),
            name: t.name,
            start_date: exportDate(t.start_date),
            end_date: exportDate(t.end_date),
            duration: t.duration ?? null,
            percent_done: t.percent_done ?? 0,
            is_milestone: !!t.is_milestone,
            auto_schedule: t.auto_schedule !== false,
            note: t.note ?? null,
            assignee: t.assignee,
            custom_fields: t.custom_fields,
            custom_values: t.custom_values ?? {},
            constraint_type: t.constraint_type ?? null,
            constraint_date: exportDate(t.constraint_date),
            rollup: !!t.rollup,
            inactive: !!t.inactive,
            deadline: exportDate(t.deadline),
            order_index: t.order_index,
          })),
        dependencies: dependencies.map(d => ({
          from_task_code: idMap.get(d.from_task_id)?.task_code ?? '',
          to_task_code: idMap.get(d.to_task_id)?.task_code ?? '',
          type: d.type,
          lag: d.lag,
          active: d.active !== false,
        })).filter(d => d.from_task_code && d.to_task_code),
      }
      const r = await authFetch('/api/mpp/build', {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify(payload),
      })
      if (!r.ok) {
        const text = await r.text()
        try { const j = JSON.parse(text); throw new Error(j.error || text) } catch { throw new Error(text) }
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${currentProject?.name ?? 'project'}.mpp`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`导出 MS Project 失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [tasks, dependencies, currentProject, isMinute, projectLines])

  const handleCreateShareLink = useCallback(async () => {
    try {
      const response = await authFetch('/api/share-links', {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ projectId }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error ?? '创建分享链接失败')
      const url = `${window.location.origin}/share/${data.value.code}`
      setExportDropdown(false)
      const copied = await copyText(url)
      if (copied) {
        alert('分享链接已复制，有效期一小时。获得链接的人无需登录，并可使用项目全部功能。')
      } else {
        window.prompt('分享链接已创建，有效期一小时。请手动复制：', url)
      }
    } catch (error) {
      alert(`创建分享链接失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }, [projectId])

  // ── Import (Excel + MPP 共用流程) ─────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mppFileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const applyParsedImport = useCallback(async (
    parsed: { tasks: ImportTask[]; dependencies: ImportDep[]; statusDate?: string | null; projectLines?: ImportProjectLine[]; customFields?: TaskCustomField[] },
    sourceLabel: string,
  ) => {
      if (parsed.tasks.length === 0) { alert(`${sourceLabel} 中没有找到有效任务数据`); return }

      // ── 客户端数据校验：阻止会导致渲染崩溃的数据 ──
      const validationErrors = validateImportData(parsed.tasks, parsed.dependencies)
      if (validationErrors.length > 0) {
        const msgs = validationErrors.map(e => `• ${e.message}`)
        alert(`导入数据校验失败，请修正 ${sourceLabel} 后重试：\n\n${msgs.join('\n')}`)
        return
      }

      // Let user choose import mode
      const choice = prompt(
        `解析到 ${parsed.tasks.length} 个任务和 ${parsed.dependencies.length} 个依赖关系。\n` +
        (parsed.customFields?.length ? `任务属性：${parsed.customFields.map(f => `${f.name}（${CUSTOM_FIELD_TYPES[f.type]}${f.unit ? `，${f.unit}` : ''}）`).join('、')}。\n` : '') + '\n' +
        `请选择导入模式：\n` +
        `  1 = 替换导入（删除所有现有数据，用 ${sourceLabel} 数据替换）\n` +
        `  2 = 合并导入（保留现有数据，更新已有任务，新增新任务）\n\n` +
        `输入 1 或 2：`,
        '2'
      )
      if (!choice || (choice !== '1' && choice !== '2')) return

      const mode = choice === '1' ? 'replace' : 'merge'
      if (mode === 'replace') {
        const ok = confirm('⚠️ 替换导入将替换当前未保存的修改，可以撤销；通过顶部保存操作后才会写入数据库。\n\n确认继续？')
        if (!ok) return
      }

      setImporting(true)
      const safeDateRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/
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

      const attributePrevious = new Map(tasks.map(t => [t.task_code, t]))
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
          duration: it.duration ?? 0, duration_unit: 'minute',
          percent_done: it.percent_done ?? 0,
          is_milestone: it.is_milestone,
          note: it.note,
          ...mergeTaskAttributes(it, attributePrevious.get(it.task_code), parsed.customFields ?? currentProject?.custom_fields ?? []),
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

      dispatch(labelDraftStep(`${sourceLabel} ${mode === 'replace' ? '替换' : '合并'}导入`))
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
      alert(`导入成功！${nextTasks.length} 个任务、${nextDeps.length} 条依赖已加载到本地，${reasonsRequired ? '“确认变更 → 确认并保存”后入库' : '点击顶部“保存”直接入库'}。`)
  }, [dispatch, projectId, tasks, dependencies, currentProject?.custom_fields, reasonsRequired])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true)
    try {
      const parsed = await parseExcelFile(file, { isMinute, customFields: currentProject?.custom_fields })
      await applyParsedImport(parsed, 'Excel')
    } catch (err) {
      alert(`解析 Excel 文件失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setImporting(false)
    }
  }, [applyParsedImport, isMinute, currentProject?.custom_fields])

  const handleImportMpp = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await authFetch('/api/mpp/parse', { method: 'POST', body: fd })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`)
      const v = d.value as {
        tasks: ImportTask[]
        dependencies: ImportDep[]
        status_date: string | null
        project_lines?: ImportProjectLine[]
        custom_fields?: TaskCustomField[]
      }
      await applyParsedImport({
        tasks: v.tasks,
        dependencies: v.dependencies,
        statusDate: v.status_date,
        projectLines: v.project_lines,
        customFields: v.custom_fields,
      }, 'MS Project')
    } catch (err) {
      alert(`导入 MS Project 文件失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setImporting(false)
    }
  }, [applyParsedImport])

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
    const statusDateStr = toDateTimeStr(currentProject?.status_date ?? null)
    const startD = statusDateStr ? new Date(statusDateStr) : new Date()
    if (!isMinute) startD.setHours(0, 0, 0, 0)
    const endD = new Date(startD)
    if (isMinute) endD.setMinutes(endD.getMinutes() + 60)
    else endD.setDate(endD.getDate() + 1)
    const startStr = isMinute ? toDateTimeStr(startD)! : fmtD(startD)
    const endStr = isMinute ? toDateTimeStr(endD)! : fmtD(endD)

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
      duration: isMinute ? 60 : 1440, duration_unit: isMinute ? 'minute' : 'day',
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
  }, [dispatch, projectId, tasks, currentProject, isMinute])

  // ── Delete（本地）────────────────────────────────────────────────────────
  const handleDeleteTasks = useCallback(() => {
    if (!hasSelection) return
    if (!confirm(`确定删除 ${selectedIds.length} 个任务？`)) return
    // 同时移除关联依赖
    const ids = new Set(selectedIds)
    const relatedDeps = dependencies.filter(d => ids.has(d.from_task_id) || ids.has(d.to_task_id))
    const remainDeps = dependencies.filter(d => !relatedDeps.some(x => x.id === d.id))
    const remainTasks = tasks.filter(t => !ids.has(t.id))
      const cascaded = collapseDeletedTaskSuccessors(
        remainTasks,
        dependencies,
        remainDeps,
        ids,
        currentProject?.status_date,
        { isMinute },
      )
    for (const d of relatedDeps) dispatch(removeDependency(d.id))
    dispatch(deleteTasks(selectedIds))
    if (cascaded.length > 0) {
      dispatch(updateTasks(cascaded))
      dispatch(markDirty(cascaded.map(t => t.id)))
    }
  }, [dispatch, selectedIds, hasSelection, tasks, dependencies, currentProject?.status_date])

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
        const dur = scheduleDurationMinutes(minStart, maxEnd, isMinute)
        parentUpdates.push({ ...parent, start_date: minStart, end_date: maxEnd, duration: dur })
      }
    }
    if (parentUpdates.length > 0) dispatch(updateTasks(parentUpdates))

    dispatch(markDirty([...allUpdates.map(u => u.id), ...parentUpdates.map(t => t.id)]))
  }, [dispatch, projectId, tasks, selectedIds, hasSelection, dependencies, isMinute])

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
      const dur = scheduleDurationMinutes(minStart, maxEnd, isMinute)
      parentUpdates.push({ ...parent, start_date: minStart, end_date: maxEnd, duration: dur })
    }
    if (parentUpdates.length > 0) dispatch(updateTasks(parentUpdates))

    dispatch(markDirty([...allUpdates.map(u => u.id), ...parentUpdates.map(t => t.id)]))
  }, [dispatch, projectId, tasks, selectedIds, hasSelection, dependencies, isMinute])

  // ── Copy / Paste ──────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (!hasSelection) return
    dispatch(copyTasks(selectedIds))
  }, [dispatch, selectedIds, hasSelection])

  const handlePaste = useCallback(() => {
    if (clipboard.length === 0 || readOnly) return
    const target = getFlatOrder(tasks).filter(t => selectedIds.includes(t.id)).at(-1)
    const result = buildTaskCopies(tasks, dependencies, clipboard.map(t => t.id), target?.id ?? null, 'after', {
      tasks: clipboard, dependencies: clipboardDeps,
    })
    if (!result.tasksToAdd.length) return
    dispatch(labelDraftStep('粘贴任务'))
    dispatch(updateTasks(result.tasksToUpdate))
    dispatch(addTasks(result.tasksToAdd))
    result.dependenciesToAdd.forEach(d => dispatch(addDependency(d)))
    const updated = new Map(result.tasksToUpdate.map(t => [t.id, t]))
    const nextTasks = [...tasks.map(t => updated.get(t.id) ?? t), ...result.tasksToAdd]
    const cascaded = runFullCascade(nextTasks, [...dependencies, ...result.dependenciesToAdd], { isMinute })
    if (cascaded.length) dispatch(updateTasks(cascaded))
    dispatch(markDirty([...result.tasksToAdd, ...result.tasksToUpdate, ...cascaded].map(t => t.id)))
    dispatch(setSelectedIds(result.tasksToAdd.map(t => t.id)))
    requestAnimationFrame(() => onFocusTask())
  }, [dispatch, tasks, dependencies, clipboard, clipboardDeps, selectedIds, isMinute, readOnly, onFocusTask])

  // ── Status date: free movement + separate confirm button ────────
  const [statusDateSaving, setStatusDateSaving] = useState(false)
  const readPersistedState = useCallback(async (): Promise<SaveBaseline> => {
    const [taskRes, projectRes, lineRes] = await Promise.all([
      authFetch(`/api/tasks/${projectId}`), authFetch(`/api/projects/${projectId}`), authFetch(`/api/project-lines/${projectId}`),
    ])
    const [taskData, projectData, lineData] = await Promise.all([taskRes.json(), projectRes.json(), lineRes.json()])
    if (!taskRes.ok || !taskData.ok || !projectRes.ok || !projectData.ok || !lineRes.ok || !lineData.ok || !Array.isArray(lineData.value)
        || !Array.isArray(taskData.value?.tasks) || !Array.isArray(taskData.value?.dependencies)) {
      throw new Error('无法读取后台最新计划，请稍后重试；当前修改仍保留')
    }
    return {
      tasks: taskData.value.tasks, dependencies: taskData.value.dependencies,
      statusDate: toDateTimeStr(projectData.value.status_date ?? null), lines: lineData.value,
      planningStatus: normalizePlanningStatus(projectData.value.planning_status),
      customFields: projectData.value.custom_fields ?? [],
    }
  }, [projectId])

  // 状态日期仅改 Redux，用户通过顶部工具栏保存时才入库。
  // 允许任意日期时间以便预览进展；稳定态审核保存时创建版本快照，
  // 点"放弃更改"则回到基线值。这样状态日期与任务/依赖一致，都受 dirty 状态约束。
  const handleStatusDatePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = normalizeStatusDate(e.target.value || null)
    dispatch(labelDraftStep('修改状态日期'))
    dispatch(setStatusDate({ projectId, statusDate: val }))
  }, [dispatch, projectId, normalizeStatusDate])

  // 草稿态直接保存；稳定态经审核后保存，并创建版本快照。
  const handleConfirmChanges = useCallback(async () => {
    const sd = toDateTimeStr(currentProject?.status_date ?? null)
    const createVersion = normalizePlanningStatus(currentProject?.planning_status) === 'stable'
    if (readOnly || (createVersion && !sd) || statusDateSaving || !allReasonsFilled) return

    setStatusDateSaving(true)
    dispatch(beginDraftSave())
    const submittedLines = reduxStore.getState().projectLines.lines
    // Freeze this attempt before the first await. Later edits stay in Redux.
    const submitted = reduxStore.getState().tasks
    const submittedTasks = submitted.tasks
    const submittedDeps = submitted.dependencies
    const submittedPlanningStatus = normalizePlanningStatus(reduxStore.getState().project.currentProject?.planning_status)
    const submittedCustomFields = reduxStore.getState().project.currentProject?.custom_fields ?? []
    // Direct draft saves must not reuse reasons from an earlier stable review.
    const submittedDependencyReasons = createVersion ? dependencyReasons : {}
    const saveHeaders = authFetchHeaders(true)
    saveHeaders.set('x-gantt-confirmed-save', '1')
    const saveWarnings: Array<{ taskName: string; message: string }> = []
    try {
      // Compare every save with the latest database records, not the page-load
      // baseline. The submitted plan wins for known records; unseen additions
      // from other sessions must never become accidental deletions.
      const persisted = await readPersistedState()
      const saveBaseTasks = recoverSaveRecords(baselineTasks, persisted.tasks,
        [...attemptedSaveIds.current.taskIds, ...submittedTasks.map(t => t.id)])
      const saveBaseDeps = recoverSaveRecords(baselineDeps, persisted.dependencies,
        [...attemptedSaveIds.current.dependencyIds, ...submittedDeps.map(d => d.id)])
      const saveBaseStatusDate = persisted.statusDate
      const saveBasePlanningStatus = normalizePlanningStatus(persisted.planningStatus)
      const saveBaseCustomFields = persisted.customFields ?? []
      const saveBaseLines = recoverSaveRecords(baselineLines, persisted.lines ?? [],
        [...attemptedLineIds.current, ...submittedLines.map(l => l.id)])

      // Definitions must exist before tasks reference them. This is inside the
      // explicit confirm flow; recovery reads this state after any partial save.
      if (!customFieldsEqual(saveBaseCustomFields, submittedCustomFields)) {
        const r = await authFetch(`/api/projects/${projectId}`, { method: 'PUT', headers: saveHeaders,
          body: JSON.stringify({ custom_fields: submittedCustomFields }) })
        const result = await r.json()
        if (!r.ok || !result.ok) throw new Error(result.error ?? '保存任务属性配置失败')
      }

      // 1. 重算 percent_done + baseline_end_date（基于上一版本快照）
      const sdDate = sd ? new Date(sd) : null
      const prevEndByTaskId = new Map<string, string | null>()
      const prevVersion = versions[0]
      if (createVersion && prevVersion) {
        try {
          const r = await authFetch(`/api/versions/${projectId}?id=${prevVersion.id}`)
          const d = await r.json()
          if (d.ok && Array.isArray(d.value?.snapshot?.tasks)) {
            for (const pt of d.value.snapshot.tasks as { id: string; end_date: string | null }[]) {
              prevEndByTaskId.set(pt.id, snapshotEndForBaseline(pt.end_date))
            }
          }
        } catch { /* ignore, 退化为当前 end */ }
      }
      const recomputed = createVersion && sdDate ? submittedTasks
        .filter(t => t.start_date && t.end_date)
        .map(t => {
          const prevEnd = prevEndByTaskId.get(t.id) ?? null
          const baselineEnd = prevEnd ?? snapshotEndForBaseline(t.end_date)
          return {
            ...t,
            percent_done: calcPercent(t, sdDate),
            baseline_end_date: baselineEnd,
          }
        }) : []
      const finalTasks = submittedTasks.map(t => recomputed.find(u => u.id === t.id) ?? t)

      const reasonMap: Record<string, string> = {}
      for (const d of createVersion ? changeDiffs : []) {
        if (requiredReasonCodes.has(d.task_code)) {
          const r = (reasons[d.task_code] ?? '').trim()
          if (r) reasonMap[d.task_code] = r
        } else if (passiveReasonMap[d.task_code]) {
          reasonMap[d.task_code] = passiveReasonMap[d.task_code]
        }
      }
      const reasonByTaskId = Object.fromEntries(
        [...baselineTasks, ...submittedTasks].map(t => [t.id, reasonMap[t.task_code] ?? null]),
      )

      // 2. 与基线 diff，生成批量操作
      const diff = buildSaveDiff(saveBaseTasks, saveBaseDeps, finalTasks, submittedDeps)
      for (const id of [...diff.tasksToAdd.map(t => t.id), ...diff.tasksToUpdate.map(t => t.id), ...diff.tasksToDelete]) {
        attemptedSaveIds.current.taskIds.add(id)
      }
      for (const id of [...diff.depsToAdd.map(d => d.id), ...diff.depsToUpdate.map(d => d.id), ...diff.depsToDelete]) {
        attemptedSaveIds.current.dependencyIds.add(id)
      }
      // 删除依赖必须先于删除任务，避免外键级联删除丢失审计
      for (const depId of diff.depsToDelete) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'DELETE', headers: saveHeaders,
          body: JSON.stringify({ id: depId, _reason: submittedDependencyReasons[depId]?.trim() }),
        })
        if (!r.ok) throw new Error(`删除依赖失败 (${r.status})`)
      }
      // 新增任务（连同 client id / task_code）
      if (diff.tasksToAdd.length > 0) {
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'POST', headers: saveHeaders,
          // Create IDs first, then apply all new/existing parent changes in one
          // PUT graph. An intermediate old hierarchy can otherwise look cyclic
          // and cause a valid new parent edge to be "repaired" away.
          body: JSON.stringify(diff.tasksToAdd.map(t => ({ ...t, parent_id: null, _reason: reasonByTaskId[t.id] }))),
        })
        const result = await r.json()
        if (!r.ok || !result.ok || !Array.isArray(result.value)) throw new Error(result.error ?? `新增任务失败 (${r.status})`)
        if (Array.isArray(result.warnings)) saveWarnings.push(...result.warnings)
        // The recovery read may precede an earlier request's commit. An
        // idempotent POST can then return that request's older values.
        diff.tasksToUpdate.push(...buildSaveDiff(result.value, [], diff.tasksToAdd, []).tasksToUpdate)
      }
      // 更新任务
      if (diff.tasksToUpdate.length > 0) {
        const payload = diff.tasksToUpdate.map(t => ({
          id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, duration_unit: t.duration_unit, percent_done: t.percent_done, parent_id: t.parent_id,
          order_index: t.order_index, is_milestone: t.is_milestone, auto_schedule: t.auto_schedule,
          assignee: t.assignee, note: t.note, custom_fields: t.custom_fields, custom_values: t.custom_values,
          constraint_type: t.constraint_type, constraint_date: t.constraint_date,
          status: t.status, deadline: t.deadline,
          rollup: t.rollup, inactive: t.inactive, project_boundary: t.project_boundary,
          baseline_end_date: t.baseline_end_date, task_code: t.task_code,
          _reason: reasonByTaskId[t.id],
        }))
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'PUT', headers: saveHeaders,
          body: JSON.stringify(payload),
        })
        const result = await r.json()
        if (!r.ok || !result.ok) throw new Error(result.error ?? `更新任务失败 (${r.status})`)
        if (Array.isArray(result.warnings)) saveWarnings.push(...result.warnings)
      }
      // 删除任务
      if (diff.tasksToDelete.length > 0) {
        const r = await authFetch(`/api/tasks/${projectId}`, {
          method: 'DELETE', headers: saveHeaders,
          body: JSON.stringify({ ids: diff.tasksToDelete, reasons: reasonByTaskId }),
        })
        if (!r.ok) throw new Error(`删除任务失败 (${r.status})`)
      }
      // 新增依赖
      for (const dep of diff.depsToAdd) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'POST', headers: saveHeaders,
          body: JSON.stringify({
            id: dep.id, from_task_id: dep.from_task_id, to_task_id: dep.to_task_id,
            type: dep.type, lag: dep.lag, active: dep.active ?? true,
            _reason: submittedDependencyReasons[dep.id]?.trim(),
          }),
        })
        const result = await r.json()
        if (!r.ok || !result.ok || !result.value?.dependency) throw new Error(result.error ?? `新增依赖失败 (${r.status})`)
        diff.depsToUpdate.push(...buildSaveDiff([], [result.value.dependency], [], [dep]).depsToUpdate)
      }
      // 更新依赖
      for (const dep of diff.depsToUpdate) {
        const r = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'PUT', headers: saveHeaders,
          body: JSON.stringify({ id: dep.id, type: dep.type, lag: dep.lag, active: dep.active ?? true, _reason: submittedDependencyReasons[dep.id]?.trim() }),
        })
        if (!r.ok) throw new Error(`更新依赖失败 (${r.status})`)
      }

      // 2.5 状态日期若有变更，先把它持久化到 projects 表
      //     （版本快照只写 project_versions.status_date，不会同步 projects.status_date）
      if (sd !== saveBaseStatusDate || submittedPlanningStatus !== saveBasePlanningStatus) {
        const r = await authFetch(`/api/projects/${projectId}`, {
          method: 'PUT',
          headers: saveHeaders,
          body: JSON.stringify({ status_date: sd, planning_status: submittedPlanningStatus }),
        })
        if (!r.ok) throw new Error(`保存项目状态失败 (${r.status})`)
      }

      // Project lines use client IDs so a lost reply can be retried safely.
      for (const line of saveBaseLines) {
        if (submittedLines.some(l => l.id === line.id)) continue
        attemptedLineIds.current.add(line.id)
        const r = await authFetch(`/api/project-lines/${projectId}`, {
          method: 'DELETE', headers: saveHeaders, body: JSON.stringify({ id: line.id }),
        })
        if (!r.ok) throw new Error(`删除项目线失败 (${r.status})`)
      }
      const savedLineMap = new Map(submittedLines.map(l => [l.id, l]))
      for (const line of submittedLines) {
        const old = saveBaseLines.find(l => l.id === line.id)
        if (old && linesEqual([old], [line])) continue
        attemptedLineIds.current.add(line.id)
        const r = await authFetch(`/api/project-lines/${projectId}`, {
          method: old ? 'PUT' : 'POST', headers: saveHeaders, body: JSON.stringify(line),
        })
        const d = await r.json()
        if (!r.ok || !d.ok || !d.value?.id) throw new Error(d.error ?? `保存项目线失败 (${r.status})`)
        savedLineMap.set(line.id, d.value)
      }
      const savedLines = [...savedLineMap.values()]

      // 草稿态只读取已保存的当前计划；稳定态才创建历史版本。
      let confirmed: SaveBaseline
      if (createVersion) {
        const snapshotRes = await authFetch(`/api/versions/${projectId}`, {
          method: 'POST', headers: saveHeaders,
          body: JSON.stringify({ use_database_snapshot: true, include_snapshot: true, status_date: sd, reasons: reasonMap,
            ...(customFieldsChanged ? { description: `任务属性配置变更：${submittedCustomFields.map(f => `${f.name}（${CUSTOM_FIELD_TYPES[f.type]}${f.archived ? '，停用' : ''}）`).join('、')}。原因：${customFieldsReason.trim()}` } : {}),
          }),
        })
        const snapshotData = await snapshotRes.json()
        if (!snapshotRes.ok || !snapshotData.ok) throw new Error(snapshotData.error ?? `版本保存失败 (${snapshotRes.status})`)
        const snapshot = snapshotData.value?.snapshot
        if (!Array.isArray(snapshot?.tasks) || !Array.isArray(snapshot?.dependencies)) throw new Error('版本响应缺少保存结果，请重试')
        confirmed = {
          tasks: snapshot.tasks, dependencies: snapshot.dependencies, statusDate: sd,
          planningStatus: normalizePlanningStatus(snapshot.planning_status),
          customFields: snapshot.custom_fields ?? submittedCustomFields,
          lines: Array.isArray(snapshot.lines) ? snapshot.lines : savedLines,
        }
      } else {
        confirmed = await readPersistedState()
      }
      const savedTasks = confirmed.tasks
      const savedDeps = confirmed.dependencies
      const confirmedLines = confirmed.lines ?? savedLines
      const savedPlanningStatus = normalizePlanningStatus(confirmed.planningStatus)
      // Both save modes create an undo boundary while retaining later local edits.
      dispatch(finishDraftSave({ ...confirmed, planningStatus: savedPlanningStatus, lines: confirmedLines, descriptions: {} }))
      setBaselinePlanningStatus(savedPlanningStatus)
      setBaselineCustomFields(confirmed.customFields ?? [])
      setBaselineLines(confirmedLines)
      attemptedLineIds.current.clear()
      setReviewOpen(false)
      // 重置基线为已落库的当前状态
      const livingTasks = savedTasks.filter(t => !t.is_deleted)
      setBaseline(livingTasks.map(t => ({
        id: t.id, task_code: t.task_code, name: t.name,
        start_date: t.start_date, end_date: t.end_date,
        duration: t.duration, assignee: t.assignee,
        percent_done: t.percent_done, is_milestone: t.is_milestone, order_index: t.order_index,
        auto_schedule: t.auto_schedule, note: t.note, custom_fields: t.custom_fields, custom_values: t.custom_values,
        parent_id: t.parent_id,
      })))
      setBaselineTasks(livingTasks.map(t => ({ ...t })))
      setBaselineDeps(savedDeps.map(d => ({ ...d })))
      setBaselineStatusDate(confirmed.statusDate)
      if (saveWarnings.length) alert(`所有任务修改已保存。以下无效父级关联已修正，并记入任务历史：\n${saveWarnings.map(w => `${w.taskName}：${w.message}`).join('\n')}`)
      setSaveIncomplete(false)
      attemptedSaveIds.current = { taskIds: new Set(), dependencyIds: new Set() }

      authFetch(`/api/versions/${projectId}?list=1`)
        .then(r => r.json())
        .then(d => { if (d.ok && Array.isArray(d.value)) dispatch(setVersions(d.value)) })
        .catch(() => {})
    } catch (err) {
      dispatch(failDraftSave())
      setSaveIncomplete(true)
      console.error('计划保存失败:', err)
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}。请重试，系统会核对已保存的内容。`)
    } finally {
      setStatusDateSaving(false)
    }
  }, [currentProject, statusDateSaving, dispatch, projectId, tasks, dependencies,
      changeDiffs, versions, reasons, dependencyReasons, allReasonsFilled, requiredReasonCodes, passiveReasonMap,
      baselineTasks, baselineDeps, baselineStatusDate, baselinePlanningStatus, saveIncomplete, readPersistedState, reduxStore,
      snapshotEndForBaseline, baselineLines, baselineCustomFields, customFieldsChanged, customFieldsReason, readOnly])

  // ── 放弃更改：恢复到进入页面后捕获的基线，所有未确认编辑都丢弃 ──
  const handleRefresh = useCallback(async () => {
    if (!baseline) return
    if (statusDateSaving) return
    setStatusDateSaving(true)
    try {
      const persisted = saveIncomplete || history.uncertain ? await readPersistedState() : null
      const restoredTasks = (persisted?.tasks ?? baselineTasks).map(t => ({ ...t }))
      const restoredDeps = (persisted?.dependencies ?? baselineDeps).map(d => ({ ...d }))
      const restoredStatusDate = persisted ? persisted.statusDate : baselineStatusDate
      const restoredPlanningStatus = persisted ? normalizePlanningStatus(persisted.planningStatus) : baselinePlanningStatus
      setBaselinePlanningStatus(restoredPlanningStatus)
      const restoredCustomFields = persisted?.customFields ?? baselineCustomFields
      setBaselineCustomFields(restoredCustomFields)
      if (persisted) {
        setBaseline(restoredTasks.map(t => ({ ...t })))
        setBaselineTasks(restoredTasks)
        setBaselineDeps(restoredDeps)
        setBaselineStatusDate(restoredStatusDate)
      }
      const restoredLines = persisted?.lines ?? baselineLines
      setBaselineLines(restoredLines)
      dispatch(resetDraft({ tasks: restoredTasks, dependencies: restoredDeps, statusDate: restoredStatusDate, planningStatus: restoredPlanningStatus, customFields: restoredCustomFields, lines: restoredLines, descriptions: {} }))
      attemptedLineIds.current.clear()
      dispatch(clearComparison())
      dispatch(clearDiffFilter())
      onDiscardChanges?.()
      setReviewOpen(false)
      setReasons({})
      setSaveIncomplete(false)
      attemptedSaveIds.current = { taskIds: new Set(), dependencyIds: new Set() }
    } catch (err) {
      alert(`放弃更改失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setStatusDateSaving(false)
    }
  }, [baseline, baselineTasks, baselineDeps, baselineStatusDate, baselinePlanningStatus, dispatch, projectId, onDiscardChanges,
      statusDateSaving, saveIncomplete, readPersistedState, baselineLines, baselineCustomFields, history.uncertain])

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((document.activeElement as HTMLElement)?.closest('input, textarea, select, [contenteditable=true], [role=dialog]')) return
      if (readOnly) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch(e.shiftKey ? redoDraft() : undoDraft()); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); dispatch(redoDraft()); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') handleCopy()
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !(document.activeElement as HTMLElement)?.closest('[data-gantt-grid]')) handlePaste()
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch, handleCopy, handlePaste, readOnly])

  const sep = <div className="w-px h-6 bg-gray-200 mx-1" />

  return (
    <>
      <div className="relative z-20 border-b border-gray-200 bg-white">
      <div data-toolbar-row="tasks" className="flex flex-wrap items-center gap-1.5 px-3 py-2">

        {readOnly && (
          <span className="text-[11px] text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-1 font-medium whitespace-nowrap">
            只读模式
          </span>
        )}

        {!readOnly && (
          <>
            <Ic title={`撤销${history.past.at(-1) ? '：' + history.past.at(-1)!.label : ''} (Ctrl+Z)`} disabled={!history.past.length || history.saving || history.uncertain} onClick={() => dispatch(undoDraft())}><IcoUndo /></Ic>
            <Ic title="重做 (Ctrl+Shift+Z / Ctrl+Y)" disabled={!history.future.length || history.saving || history.uncertain} onClick={() => dispatch(redoDraft())}><IcoRedo /></Ic>
            {/* Group 1: Create + Edit */}
            <LabelIc title="创建任务" icon={<IcoPlus />} label="新建任务" onClick={handleAddTask} />
            <LabelIc title="编辑任务" icon={<IcoPencil />} label="编辑任务" disabled={selectedIds.length !== 1}
                     onClick={() => selectedIds.length === 1 && setEditModalOpen(true)} />

            {sep}
          </>
        )}

        {readOnly && sep}

        <ToolbarActionMenu label="任务操作" actions={[
          ...(!readOnly ? [
            { label: '批量修改任务', disabled: !hasSelection, onSelect: () => setBulkEditOpen(true) },
            { label: '复制选中任务', disabled: !hasSelection, shortcut: 'Ctrl/Cmd+C', divider: true, onSelect: handleCopy },
            { label: '粘贴任务', disabled: clipboard.length === 0, shortcut: 'Ctrl/Cmd+V', onSelect: handlePaste },
            { label: '提升任务层级', disabled: !hasSelection, divider: true, onSelect: handlePromote },
            { label: '降为子任务', disabled: !hasSelection, onSelect: handleDemote },
          ] : []),
          ...(readOnly ? [{ label: '查看任务属性', disabled: selectedIds.length !== 1, onSelect: () => setAttributeViewTask((viewSnapshot?.tasks ?? tasks).find(t => t.id === selectedIds[0]) ?? null) }] : []),
          { label: '定位到选中任务', disabled: !hasSelection, onSelect: onFocusTask },
          ...(!readOnly ? [{ label: '删除选中任务', disabled: !hasSelection, danger: true, divider: true, onSelect: handleDeleteTasks }] : []),
        ]} />

        {sep}

        {/* Group 4: Zoom + Focus + Indent/Outdent */}
        <Ic title={`放大 (当前: ${colW}px)`} disabled={colW >= zoomMax} onClick={onZoomIn}><IcoZoomIn /></Ic>
        <Ic title={`缩小 (当前: ${colW}px)`} disabled={colW <= zoomMin} onClick={onZoomOut}><IcoZoomOut /></Ic>
        <button className="border border-gray-300 rounded px-2 h-8 text-xs" onClick={() => onTimelineNavigate?.('all')}>显示全部</button>
        <button className="border border-gray-300 rounded px-2 h-8 text-xs disabled:opacity-40" disabled={!hasSelection} onClick={() => onTimelineNavigate?.('selection')}>适配所选</button>
        <button className="border border-gray-300 rounded px-2 h-8 text-xs" onClick={() => onTimelineNavigate?.('status')}>回到状态日期</button>

        {sep}

        {selectedIds.length > 0 && <div className="flex items-center gap-2 rounded bg-blue-50 px-2 py-1.5 text-xs">
          <span className="whitespace-nowrap text-blue-700">已选 {selectedIds.length} 个任务</span>
          <button className="text-blue-600 hover:underline" onClick={() => dispatch(setSelectedIds([]))}>清除选择</button>
        </div>}
        {history.uncertain && <span className="text-xs text-amber-700">上次保存结果待核对，请重试保存或放弃全部更改</span>}
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

        <GanttDisplaySettings visibleCols={visibleCols} onVisibleColsChange={onVisibleColsChange}
          indicators={indicators} onIndicatorsChange={onIndicatorsChange}
          onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} viewControls={viewControls} />
      </div>
      <div data-toolbar-row="progress" className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 bg-gray-50/60 px-3 py-2">
        <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 whitespace-nowrap">
          计划状态
          <select aria-label="计划状态" value={displayedPlanningStatus} disabled={readOnly || statusDateSaving}
                  title="草稿态点击保存直接入库，不审核、不填原因、不生成历史版本；稳定态审核后保存。状态切换在保存后生效"
                  className="h-8 rounded border border-gray-300 bg-white px-2 text-[13px] text-gray-700 disabled:bg-gray-50"
                  onChange={e => {
                    dispatch(labelDraftStep('切换计划状态'))
                    dispatch(setPlanningStatus({ projectId, planningStatus: normalizePlanningStatus(e.target.value) }))
                  }}>
            <option value="draft">草稿态</option>
            <option value="stable">稳定态</option>
          </select>
          {planningStatusChanged && !readOnly && <span className="text-amber-600">未保存</span>}
        </label>

        {!readOnly && (
          <>
            {sep}

            {/* Status date */}
            <div className="relative flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-gray-500 whitespace-nowrap">{isMinute ? '状态时间' : '状态日期'}</span>
              {(() => {
                const v = currentProject?.status_date ?? ''
                return (
                  <YmdDateInput
                    value={v}
                    onChange={handleStatusDatePick}
                    includeTime={isMinute}
                    min={statusDateRange.min}
                    max={statusDateRange.max}
                    minuteStep={isMinute ? 1 : 15}
                  />
                )
              })()}
              {(() => {
                const sd = toDateTimeStr(currentProject?.status_date ?? null)
                const sdLabel = isMinute ? '状态时间' : '状态日期'
                const canSubmit = (!reasonsRequired || !!sd) && !statusDateSaving && hasChanges
                const tip = reasonsRequired && !sd
                  ? `请先设置${sdLabel}`
                  : hasChanges ? (reasonsRequired ? '确认变更：保存所有改动并创建版本快照' : '保存当前计划，直接入库，不审核、不生成历史版本')
                  : '没有变更，无需保存'
                return (
                  <button
                    data-action="save-plan"
                    onClick={() => {
                      if (reasonsRequired && !sd) { alert(`请先设置${sdLabel}`); return }
                      if (reasonsRequired) openReview()
                      else void handleConfirmChanges()
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
                    {statusDateSaving ? '保存中...' : reasonsRequired ? '确认变更' : '保存'}
                  </button>
                )
              })()}
              {!readOnly && (
                <button
                  onClick={handleRefresh}
                  disabled={statusDateSaving}
                  title="放弃全部未确认的草稿，回到最近一次保存状态"
                  className="inline-flex items-center gap-1 px-2.5 h-8 rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 cursor-pointer text-[13px] font-medium transition-colors"
                >
                  <IcoRefresh />
                  放弃全部更改
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
                      const label = versionLabel(v)
                      const sd = formatStatusDate(v.status_date)
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
            <span className="text-xs text-gray-500 whitespace-nowrap">{isMinute ? '状态时间' : '状态日期'}</span>
            <YmdDateInput
              value={currentProject?.status_date ?? ''}
              onChange={handleStatusDatePick}
              includeTime={isMinute}
              min={statusDateRange.min}
              max={statusDateRange.max}
              minuteStep={isMinute ? 1 : 15}
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
                value={versions.find(v => versionLabel(v) === comparison.versionName)?.id ?? ''}
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
                          versionName: versionLabel(v),
                        }))
                    }
                  } catch { /* ignore */ }
                }}
                className="bg-transparent border-none text-orange-700 text-[12px] font-medium focus:outline-none cursor-pointer pr-4"
                title="基准版本（以基线条显示）"
              >
                {versions.map(v => {
                  const label = versionLabel(v)
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
              <button className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                      onClick={handleExportMpp}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h6"/><path d="M3 1v14" strokeWidth="2"/></svg>
                导出 MS Project (.mpp)
              </button>
              {!readOnly && (
                <button className="w-full px-3 py-1.5 mt-1 border-t border-gray-100 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                        onClick={handleCreateShareLink}>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.8 7.1l4.4-2.2M5.8 8.9l4.4 2.2"/></svg>
                  复制一小时分享链接
                </button>
              )}
            </div>
          )}
        </div>

        {/* Import dropdown (Excel + MPP) */}
        {!readOnly && (
          <div className="relative">
            <Ic title="导入" onClick={() => setImportDropdown(v => !v)} disabled={importing}><IcoUpload /></Ic>
            {importDropdown && (
              <div ref={importDropdownRef}
                   className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-lg py-1 min-w-[180px]">
                <button
                  className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer disabled:opacity-50"
                  disabled={importing}
                  onClick={() => { setImportDropdown(false); fileInputRef.current?.click() }}>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h4"/></svg>
                  导入 Excel
                </button>
                <button
                  className="w-full px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer disabled:opacity-50"
                  disabled={importing}
                  onClick={() => { setImportDropdown(false); mppFileInputRef.current?.click() }}>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h6"/><path d="M3 1v14" strokeWidth="2"/></svg>
                  导入 MS Project (.mpp)
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
            <input ref={mppFileInputRef} type="file" accept=".mpp" className="hidden" onChange={handleImportMpp} />
          </div>
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
      </div>

      {retroLogOpen && (
        <RetroLogPanel projectId={projectId} onClose={() => setRetroLogOpen(false)} />
      )}

      {attributeViewTask && <TaskCustomFieldsPanel task={attributeViewTask} fields={taskCustomFields(attributeViewTask, viewSnapshot?.customFields ?? currentProject?.custom_fields)} onClose={() => setAttributeViewTask(null)} />}
      {bulkEditOpen && !readOnly && <BulkEditPanel onClose={() => setBulkEditOpen(false)} />}
      {/* Edit Task Modal */}
      {editModalOpen && selectedIds.length === 1 && (
        <EditTaskModal
          taskId={selectedIds[0]}
          projectId={projectId}
          onClose={() => setEditModalOpen(false)}
        />
      )}

      {/* Review Changes Dialog */}
      {reviewOpen && reasonsRequired && (
        <div role="dialog" aria-modal="true" aria-label="变更审核" className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                变更审核
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {isMinute ? '状态时间' : '状态日期'}: {formatStatusDate(currentProject?.status_date)}
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
                    {linesChanged && <span className="text-blue-600">项目线 {lineDiffs.length}</span>}
                    {planningStatusChanged && <span className="text-blue-600">计划状态</span>}
                    {statusDateChanged && <span className="text-orange-600">{isMinute ? '状态时间' : '状态日期'}</span>}
                    <span className="text-gray-400 ml-auto">共 {changeDiffs.length + depDiff.total + lineDiffs.length + Number(statusDateChanged) + Number(planningStatusChanged) + Number(customFieldsChanged)} 项变更</span>
                  </>
                )
              })()}
            </div>

            {/* Diff list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
              <div className="text-xs text-gray-500">
                {reasonsRequired ? '稳定态：主动变更、手动任务和依赖变更需填写原因。' : '草稿态：原因可选填，只保存当前计划，不生成历史版本。'}
              </div>
              {planningStatusChanged && <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm">
                计划状态：{planningStatusLabel(baselinePlanningStatus)} → {planningStatusLabel(planningStatus)}
              </div>}
              {customFieldsChanged && <div className="space-y-2 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
                <div className="font-medium">任务属性配置变更</div>
                {customFields.filter(f => !customFieldsEqual([f], baselineCustomFields.filter(b => b.id === f.id))).map(f => {
                  const old = baselineCustomFields.find(b => b.id === f.id)
                  return <div key={f.id}>{old ? `${old.name} → ` : '新增：'}{f.name}（{CUSTOM_FIELD_TYPES[f.type]}{f.unit ? `，${f.unit}` : ''}{f.archived ? '，停用' : ''}）{f.options ? `：${f.options.join('、')}` : ''}</div>
                })}
                <input aria-label="属性配置变更原因" value={customFieldsReason} onChange={e => setCustomFieldsReason(e.target.value)} placeholder={`配置变更原因（${reasonsRequired ? '必填' : '选填'}）`} className="w-full rounded border px-2 py-1.5" />
              </div>}
              {statusDateChanged && <div className="rounded border border-orange-200 bg-orange-50 p-3 text-sm">
                    {isMinute ? '状态时间' : '状态日期'}：
                    <span className="font-medium text-gray-800">
                      {formatStatusDate(baselineStatusDate) || '(空)'}
                    </span>
                    {' → '}
                    <span className="font-medium text-blue-700">
                      {formatStatusDate(currentProject?.status_date) || '(空)'}
                    </span>
                  </div>}
              {lineDiffs.map(({ id, before, after }) => <div key={id} className="rounded border border-blue-200 bg-blue-50 p-3 text-sm space-y-1">
                <div className="font-medium">{before ? after ? '修改' : '删除' : '新增'}项目线：{after?.name ?? before?.name}</div>
                {before && <div className="text-gray-500">原值：{before.name} · {before.line_date.slice(0, 10)} · {before.color} · {before.visible ? '显示' : '隐藏'}</div>}
                {after && <div>新值：{after.name} · {after.line_date.slice(0, 10)} · {after.color} · {after.visible ? '显示' : '隐藏'}</div>}
              </div>)}
              {changeDiffs.length === 0 && depDiff.total === 0 && !linesChanged && !statusDateChanged && !planningStatusChanged && !customFieldsChanged && (
                  <div className="text-center text-gray-400 py-8 text-sm">{saveIncomplete ? '上次保存未完成，请再次确认以完成保存' : '没有检测到变更'}</div>
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
                    {requiredReasonCodes.has(d.task_code) ? (
                      <textarea
                        aria-label={`任务 ${d.task_code} 的变更原因`}
                        aria-required={reasonsRequired}
                        value={reasons[d.task_code] ?? ''}
                        onChange={e => setReasons(prev => ({ ...prev, [d.task_code]: e.target.value }))}
                        placeholder={!reasonsRequired ? '变更原因（选填）' : manualReasonCodes.has(d.task_code) ? '手动任务原因（必填）' : '变更原因（必填，例如：设备到货延期，安装时间顺延）'}
                        rows={2}
                        className={`w-full text-xs px-2 py-1 rounded border resize-y bg-white focus:outline-none ${
                          reasonsRequired && (reasons[d.task_code] ?? '').trim().length === 0
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
                  <textarea
                    aria-label={`${item.fromName} 到 ${item.toName} 的依赖变更原因`}
                    value={dependencyReasons[item.id] ?? ''}
                    onChange={e => setDependencyReasons(prev => ({ ...prev, [item.id]: e.target.value }))}
                    aria-required={reasonsRequired}
                    placeholder={reasonsRequired ? '依赖变更原因（必填）' : '依赖变更原因（选填）'}
                    rows={2}
                    className="mt-2 w-full text-xs px-2 py-1 rounded border border-gray-300 resize-y bg-white focus:outline-none focus:border-blue-400"
                  />
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
                title={!allReasonsFilled ? '请为主动变更、手动任务和依赖变更填写原因' : ''}
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
