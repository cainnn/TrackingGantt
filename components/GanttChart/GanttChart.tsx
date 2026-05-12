'use client'

import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setSelectedIds, setTasks, updateTasks, addTasks, deleteTasks,
  addDependency, removeDependency, updateDependency,
  copyTasks,
} from '@/store/slices/tasksSlice'
import type { Task, Dependency } from '@/types'
import EditTaskModal from './EditTaskModal'
import { markDirty, setEditDescription } from '@/store/slices/tasksSlice'
import { authFetch } from '@/lib/client/authFetch'
import { runFullCascade } from '@/lib/clientScheduling'
import { uuid } from '@/lib/uuid'

// ─── Layout constants ──────────────────────────────────────────────────────
const ROW_H    = 40
const DEF_COLW = 28
const HDR_H1   = 30
const HDR_H2   = 22
const HDR_H    = HDR_H1 + HDR_H2
const BAR_H    = 20
const BAR_TOP  = (ROW_H - BAR_H) / 2

// ─── Left-panel columns ────────────────────────────────────────────────────
const COL_NUM    =  52
const COL_CHECK  =  32
const COL_NAME   = 160
const COL_ASSIGN =  72
const COL_PCT    =  48
const COL_DUR    =  48
const COL_START  =  80
const COL_END    =  80
const COL_PRED   =  56
const COL_SUCC   =  56
const COL_CTYPE  = 100
const COL_CDATE  =  88
const COL_DDATE  =  88
const COL_STATUS =  80
const MIN_NAME_W   = 60

// 限制类型 & 状态候选值
export { CONSTRAINT_TYPES, DEFAULT_CONSTRAINT_TYPE, CONSTRAINT_NEEDS_DATE } from './constants'
import { CONSTRAINT_TYPES, DEFAULT_CONSTRAINT_TYPE } from './constants'
export type AutoStatus = 'notstarted' | 'started' | 'completed' | 'ahead' | 'late' | 'pushed'
export const STATUS_META: Record<AutoStatus, { label: string; color: string }> = {
  notstarted: { label: '未开始',   color: '#6b7280' },
  started:    { label: '进行中',   color: '#2563eb' },
  completed:  { label: '已完成',   color: '#16a34a' },
  ahead:      { label: '提前完成', color: '#059669' },
  pushed:     { label: '受影响',   color: '#f59e0b' },
  late:       { label: '延期',     color: '#dc2626' },
}

// 内部辅助：判断任务当前 end_date 是否相对上期基线被延长（分钟级比较）
function isEndExtended(t: Pick<Task, 'end_date' | 'baseline_end_date'>): boolean {
  const b = t.baseline_end_date ? String(t.baseline_end_date) : null
  const e = t.end_date ? String(t.end_date) : null
  return !!(b && e && e > b)
}

export function computeTaskStatus(
  t: Task,
  statusDate: Date | null,
  ctx?: {
    allTasks: Task[]
    deps: { from_task_id: string; to_task_id: string; active?: boolean; lag?: number }[]
    prevTaskIds?: Set<string>  // 上期快照存在的任务 ID 集合，用于识别"新增任务"
    seqMap?: Map<string, number>  // 左列"编号"的 DFS 序号映射，用于归因显示
  },
): { status: AutoStatus; reason: string } {
  const baseline = t.baseline_end_date ? String(t.baseline_end_date) : null
  const curEnd   = t.end_date ? String(t.end_date) : null
  const ref      = statusDate ?? new Date()
  const timePct  = timeBasedPercent(t, ref)
  if (timePct >= 100 || (t.percent_done ?? 0) >= 100) {
    if (baseline && curEnd && curEnd < baseline) return { status: 'ahead', reason: '实际完成早于基线' }
    return { status: 'completed', reason: '' }
  }
  if (isEndExtended(t)) {
    // 归因：
    // 1. 沿依赖链递归向上，找出所有"根源"延期任务（自身被延长的最上游祖先）
    // 2. 未开工 + 有上游原因 → pushed（受影响）
    // 3. 已开工 + 有上游原因 → late（延期），原因含上游来源
    // 4. 未开工 + 无上游检测到 → pushed，原因兜底为"受上游任务影响"
    // 5. 已开工 + 无上游 → late，原因=自身工期延长
    const started = !!(t.start_date && new Date(t.start_date) <= ref)
    if (ctx) {
      const byId = new Map(ctx.allTasks.map(x => [x.id, x] as const))
      const childrenOf = new Map<string, Task[]>()
      for (const x of ctx.allTasks) {
        if (!x.parent_id) continue
        if (!childrenOf.has(x.parent_id)) childrenOf.set(x.parent_id, [])
        childrenOf.get(x.parent_id)!.push(x)
      }
      const prevIds = ctx.prevTaskIds
      const isNew = (id: string) => !!prevIds && !prevIds.has(id)
      const isDelaySource = (p: Task) => isEndExtended(p) || isNew(p.id)
      // 影响工期（分钟）：延期任务 = end - baseline；新增任务 = 自身 duration
      const endDeltaMins = (tk: Task): number => {
        if (!tk.baseline_end_date || !tk.end_date) return 0
        return Math.round((new Date(tk.end_date).getTime() - new Date(tk.baseline_end_date).getTime()) / 60_000)
      }
      const impactOf = (p: Task): number => isNew(p.id) ? (p.duration ?? 0) : endDeltaMins(p)

      // 编号显示优先用左列 seq（可视位置）；没传 seqMap 时 fallback 到 task_code
      const displayCode = (p: Task): string => {
        const seq = ctx.seqMap?.get(p.id)
        return seq != null ? String(seq) : p.task_code
      }

      type Root = { name: string; code: string; kind: 'extended' | 'new'; impact: number }
      const rootsMap = new Map<string, Root>()
      const walkedUp = new Set<string>()
      const walkUp = (id: string) => {
        if (walkedUp.has(id)) return
        walkedUp.add(id)
        const inDeps = ctx.deps.filter(d => d.to_task_id === id && d.active !== false)
        for (const d of inDeps) {
          const p = byId.get(d.from_task_id)
          if (!p) continue
          if (isDelaySource(p)) {
            rootsMap.set(p.id, {
              name: p.name,
              code: displayCode(p),
              kind: isNew(p.id) ? 'new' : 'extended',
              impact: impactOf(p),
            })
          }
          walkUp(p.id)
        }
      }
      // 对当前任务自身走一次依赖链；若是汇总任务，再向下对每个后代都走一次
      walkUp(t.id)
      const walkedDown = new Set<string>()
      const walkDown = (id: string) => {
        if (walkedDown.has(id)) return
        walkedDown.add(id)
        const kids = childrenOf.get(id) ?? []
        for (const c of kids) {
          // 后代自身若是延期根源，也直接记入（支持"汇总任务下直接延期的子任务"这种场景）
          if (isDelaySource(c)) {
            rootsMap.set(c.id, {
              name: c.name,
              code: displayCode(c),
              kind: isNew(c.id) ? 'new' : 'extended',
              impact: impactOf(c),
            })
          }
          walkUp(c.id)
          walkDown(c.id)
        }
      }
      walkDown(t.id)

      // 过滤"真正根源"：没有更上游依赖的根源节点
      const trueRoots: Root[] = Array.from(rootsMap.entries()).filter(([id]) => {
        const check = new Set<string>()
        let hasUpstreamRoot = false
        const dfs = (curId: string) => {
          if (check.has(curId) || hasUpstreamRoot) return
          check.add(curId)
          const inDeps = ctx.deps.filter(d => d.to_task_id === curId && d.active !== false)
          for (const d of inDeps) {
            const p = byId.get(d.from_task_id)
            if (!p) continue
            if (rootsMap.has(p.id)) { hasUpstreamRoot = true; return }
            dfs(p.id)
          }
        }
        dfs(id)
        return !hasUpstreamRoot
      }).map(([, v]) => v)

      const lagPredDeps = ctx.deps.filter(d =>
        d.to_task_id === t.id
        && d.active !== false
        && (d.lag ?? 0) > 0
      )

      if (trueRoots.length > 0 || lagPredDeps.length > 0) {
        const reasonParts: string[] = []
        if (trueRoots.length > 0) {
          // 按影响工期从大到小排，只取最大的一个
          trueRoots.sort((a, b) => b.impact - a.impact)
          const top = trueRoots[0]
          const label = `${top.code} ${top.name}`
          const impactStr = top.impact !== 0 ? `（${fmtMinDur(top.impact, { signed: true })}）` : ''
          if (top.kind === 'new') {
            reasonParts.push(`受新增任务「${label}」插入影响${impactStr}`)
          } else {
            reasonParts.push(`受「${label}」任务延期影响${impactStr}`)
          }
        }
        if (lagPredDeps.length > 0) {
          const top = lagPredDeps.sort((a, b) => (b.lag ?? 0) - (a.lag ?? 0))[0]
          const p = byId.get(top.from_task_id)
          const pName = p?.name ?? '?'
          const pCode = p ? displayCode(p) : ''
          reasonParts.push(`依赖延迟: ${pCode ? pCode + ' ' : ''}${pName}(lag=${fmtMinDur(top.lag ?? 0)})`)
        }
        if (!started) return { status: 'pushed', reason: reasonParts.join('; ') }
        return { status: 'late', reason: `${reasonParts.join('; ')}；自身工期也延长` }
      }
      if (!started) return { status: 'pushed', reason: '受上游任务影响' }
    }
    return { status: 'late', reason: '自身工期延长' }
  }
  if (timePct > 0) return { status: 'started', reason: '' }
  return { status: 'notstarted', reason: '' }
}
// Optional column keys (编号 and 任务名称 are always shown)
export type OptionalCol = 'assignee' | 'pct' | 'duration' | 'start' | 'end' | 'pred' | 'succ' | 'lag' | 'ctype' | 'cdate' | 'ddate' | 'status' | 'inactive'
export const OPTIONAL_COL_META: { key: OptionalCol; label: string; width: number }[] = [
  { key: 'assignee',   label: '责任人',   width: COL_ASSIGN },
  { key: 'status',     label: '状态',     width: COL_STATUS },
  { key: 'pct',        label: '完成',     width: COL_PCT },
  { key: 'duration',   label: '持续时间', width: COL_DUR },
  { key: 'start',      label: '开始时间', width: COL_START },
  { key: 'end',        label: '完成时间', width: COL_END },
  { key: 'pred',       label: '前导',     width: COL_PRED },
  { key: 'succ',       label: '后继',     width: COL_SUCC },
  { key: 'lag',        label: '延迟',     width: 60 },
  { key: 'ctype',      label: '限制类型', width: COL_CTYPE },
  { key: 'cdate',      label: '限制日期', width: COL_CDATE },
  { key: 'ddate',      label: '截止日期', width: COL_DDATE },
  { key: 'inactive',   label: '无效',     width: 60 },
]
export const DEFAULT_VISIBLE_COLS: OptionalCol[] = ['assignee', 'status', 'pct', 'start', 'duration', 'pred', 'succ', 'lag', 'ctype', 'cdate', 'ddate']

// 指示器配置：在任务条上绘制附加标记
export interface IndicatorsConfig {
  deadlineDate: boolean   // 截止日期（红色虚线 + 旗子，超期时高亮）
  constraintDate: boolean // 限制日期（紫色菱形 + 短横线）
}
export const DEFAULT_INDICATORS: IndicatorsConfig = {
  deadlineDate: true,
  constraintDate: true,
}
export const INDICATOR_META: { key: keyof IndicatorsConfig; label: string }[] = [
  { key: 'deadlineDate',   label: '截止日期' },
  { key: 'constraintDate', label: '限制日期' },
]
const INIT_LEFT_W = COL_NUM + COL_CHECK + COL_NAME + DEFAULT_VISIBLE_COLS.reduce((s, k) => s + (OPTIONAL_COL_META.find(c => c.key === k)?.width ?? 0), 0)

// ─── Date helpers ──────────────────────────────────────────────────────────
// 分钟级时间轴：addDays/diffDays 现在内部走分钟精度；调用方传"天"（可小数）。
const sod      = (d: Date) => { const r=new Date(d); r.setHours(0,0,0,0); return r }
const addMins  = (d: Date, n: number) => { const r=new Date(d); r.setMinutes(r.getMinutes()+n); return r }
const diffMins = (a: Date, b: Date) => Math.round((b.getTime()-a.getTime())/60_000)
const addDays  = (d: Date, n: number) => addMins(d, Math.round(n * 1440))
const diffDays = (a: Date, b: Date) => diffMins(a, b) / 1440
const fmtDate  = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const fmtDt    = (d: Date) => `${fmtDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`
const fmtWeek  = (d: Date) => d.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })
const SNAP_MIN = 15

/** 把分钟数格式化为人类可读：'1天3小时' / '5小时15分钟' / '45分钟' / '0分钟' */
function fmtMinDur(mins: number, opts?: { signed?: boolean }): string {
  const sign = opts?.signed ? (mins > 0 ? '+' : mins < 0 ? '-' : '') : ''
  const abs = Math.abs(Math.round(mins))
  if (abs === 0) return opts?.signed ? '0分钟' : '0分钟'
  const d = Math.floor(abs / 1440)
  const h = Math.floor((abs % 1440) / 60)
  const m = abs % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分钟`)
  return `${sign}${parts.join('')}`
}

function timeBasedPercent(task: Task, statusDate: Date | null): number {
  if (!statusDate || !task.start_date || !task.end_date) return task.percent_done ?? 0
  // 分钟级：直接按时间戳比较，不再 sod() 截断到日。
  const start = new Date(task.start_date)
  const end   = new Date(task.end_date)
  if (statusDate >= end)   return 100
  if (statusDate <= start) return 0
  const total = end.getTime() - start.getTime()
  if (total <= 0) return 100
  const done = statusDate.getTime() - start.getTime()
  return Math.round((done / total) * 100)
}

// ─── Flat tree row ─────────────────────────────────────────────────────────
interface FlatRow { task: Task; level: number; hasChildren: boolean; expanded: boolean }

// ─── Dependency cascade helper ─────────────────────────────────────────────
function getDownstreamIds(taskId: string, deps: Dependency[]): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  function walk(id: string) {
    deps.filter(d => d.from_task_id === id).forEach(d => {
      if (!visited.has(d.to_task_id)) {
        visited.add(d.to_task_id)
        result.push(d.to_task_id)
        walk(d.to_task_id)
      }
    })
  }
  walk(taskId)
  return result
}

/**
 * 客户端即时级联：给定一个已变更的任务，计算所有下游依赖任务和摘要任务的新日期。
 * 返回所有需要更新的任务（不含触发任务本身）。
 */
function cascadeLocal(
  changedTask: Task,
  allTasks: Task[],
  deps: Dependency[],
): Task[] {
  const downstreamIds = getDownstreamIds(changedTask.id, deps)
  if (downstreamIds.length === 0) return []

  const localStart = new Map<string, Date>()
  const localEnd   = new Map<string, Date>()

  // 初始化所有任务日期
  allTasks.forEach(t => {
    if (t.start_date) localStart.set(t.id, new Date(t.start_date))
    if (t.end_date)   localEnd.set(t.id, new Date(t.end_date))
  })
  // 覆盖已变更任务的日期
  if (changedTask.start_date) localStart.set(changedTask.id, new Date(changedTask.start_date))
  if (changedTask.end_date)   localEnd.set(changedTask.id, new Date(changedTask.end_date))

  const result: Record<string, Task> = {}

  // 迭代式级联
  let changed = true, iter = 0
  while (changed && iter++ < downstreamIds.length + 1) {
    changed = false
    for (const toId of downstreamIds) {
      const t = allTasks.find(x => x.id === toId)
      if (!t || !t.start_date || !t.end_date) continue

      const incoming = deps.filter(d => d.to_task_id === toId)
      if (incoming.length === 0 && t.auto_schedule === false) continue
      let maxRequiredStart: Date | null = null

      for (const dep of incoming) {
        const predStart = localStart.get(dep.from_task_id)
        const predEnd   = localEnd.get(dep.from_task_id)
        if (!predStart || !predEnd) continue
        const lag = dep.lag ?? 0
        const depType = dep.type ?? 2

        let requiredStart: Date
        if (depType === 2) {
          requiredStart = addDays(predEnd, lag)
        } else if (depType === 0) {
          requiredStart = addDays(predStart, lag)
        } else if (depType === 3) {
          const curS = localStart.get(toId)!
          const curE = localEnd.get(toId)!
          const dur = diffDays(curS, curE)
          requiredStart = addDays(predEnd, lag - dur)
        } else {
          const curS = localStart.get(toId)!
          const curE = localEnd.get(toId)!
          const dur = diffDays(curS, curE)
          requiredStart = addDays(predStart, lag - dur)
        }

        if (!maxRequiredStart || requiredStart > maxRequiredStart) {
          maxRequiredStart = requiredStart
        }
      }

      if (!maxRequiredStart) continue
      const curStart = localStart.get(toId)!
      if (curStart.getTime() === maxRequiredStart.getTime()) continue

      const shift = diffDays(curStart, maxRequiredStart)
      const s = addDays(curStart, shift)
      let e = addDays(localEnd.get(toId)!, shift)
      if (t.is_milestone) e = s
      if (e < s) e = s
      localStart.set(toId, s)
      localEnd.set(toId, e)
      result[toId] = { ...t, start_date: fmtDt(s), end_date: fmtDt(e), duration: diffMins(s, e) }
      changed = true
    }
  }

  // 更新摘要任务（父任务）日期范围
  const affectedParents = new Set<string>()
  for (const id of Object.keys(result)) {
    const tk = allTasks.find(x => x.id === id)
    if (tk?.parent_id) affectedParents.add(tk.parent_id)
  }
  // 也检查直接变更任务的父级
  if (changedTask.parent_id) affectedParents.add(changedTask.parent_id)

  for (const pid of affectedParents) {
    let curPid: string | null = pid
    const seen = new Set<string>()
    while (curPid && !seen.has(curPid)) {
      seen.add(curPid)
      const children = allTasks.filter(c => c.parent_id === curPid)
      if (children.length === 0) break
      let minS: string | null = null
      let maxE: string | null = null
      for (const c of children) {
        const ct = result[c.id] ?? (c.id === changedTask.id ? changedTask : c)
        const s = ct.start_date ?? null
        const e2 = ct.end_date ?? null
        if (s && (!minS || s < minS)) minS = s
        if (e2 && (!maxE || e2 > maxE)) maxE = e2
      }
      if (minS && maxE) {
        const parent = allTasks.find(x => x.id === curPid)
        if (parent) {
          result[curPid] = {
            ...parent,
            start_date: minS,
            end_date: maxE,
            duration: diffMins(new Date(minS), new Date(maxE)),
          }
        }
      }
      curPid = allTasks.find(x => x.id === curPid)?.parent_id ?? null
    }
  }

  return Object.values(result)
}

/** 递归收集某任务的所有后代 ID（子、孙…） */
function getDescendantIds(taskId: string, tasks: Task[]): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  function walk(pid: string) {
    tasks.forEach(t => {
      if (t.parent_id === pid && !visited.has(t.id)) {
        visited.add(t.id)
        result.push(t.id)
        walk(t.id)
      }
    })
  }
  walk(taskId)
  return result
}

// ─── Drag / connect state ──────────────────────────────────────────────────
type DragMode = 'move' | 'resize-left' | 'resize-right'
interface DragState {
  taskId: string; mode: DragMode
  startMouseX: number; origStart: Date; origEnd: Date
  dragging: boolean
}
interface ConnectState {
  fromTaskId: string; fromX: number; fromY: number; curX: number; curY: number
}

// ─── Props ─────────────────────────────────────────────────────────────────
interface Props {
  projectId: string
  isMinute?: boolean  // 项目精度：true=分钟级，false=天级
  statusDate?: string | null
  colW?: number
  searchQuery?: string
  expandAllSignal?: number
  collapseAllSignal?: number
  focusSignal?: number
  showCriticalPath?: boolean
  visibleCols?: OptionalCol[]
  onVisibleColsChange?: (cols: OptionalCol[]) => void
  indicators?: IndicatorsConfig
  readOnly?: boolean
  showComparison?: boolean
}

export default function GanttChart({
  projectId,
  isMinute = false,
  statusDate,
  colW: colWProp,
  searchQuery = '',
  expandAllSignal = 0,
  collapseAllSignal = 0,
  focusSignal = 0,
  showCriticalPath = false,
  visibleCols = DEFAULT_VISIBLE_COLS,
  onVisibleColsChange,
  indicators = DEFAULT_INDICATORS,
  readOnly = false,
  showComparison = true,
}: Props) {
  const dispatch    = useAppDispatch()
  const realTasks   = useAppSelector(s => s.tasks.tasks)
  const realDeps    = useAppSelector(s => s.tasks.dependencies)
  const viewSnapshot = useAppSelector(s => s.tasks.viewSnapshot)
  const tasks       = viewSnapshot?.tasks ?? realTasks
  const deps        = viewSnapshot?.dependencies ?? realDeps
  const selectedIds = useAppSelector(s => s.tasks.selectedIds)
  const clipboard   = useAppSelector(s => s.tasks.clipboard)
  const comparison  = useAppSelector(s => s.tasks.comparison)
  const diffFilter  = useAppSelector(s => s.tasks.diffFilter)
  const currentProject = useAppSelector(s => s.project.currentProject)
  const projectLines   = useAppSelector(s => s.projectLines.lines)
  const versions       = useAppSelector(s => s.versions.versions)

  // ── 当期延期原因（task_code → reason） ─────────────────────────────────
  // 取"本期"那个版本的 changes.diffs[i].reason —— 即与主视图对应的版本：
  // 浏览历史时（viewSnapshot），当期 = 被浏览的版本本身；
  // 否则 = 最近一次非自动保存的状态日期版本。
  const filledReasonByCode = useMemo(() => {
    const m = new Map<string, string>()
    const snapshotsDesc = versions.filter(v => !v.is_autosave && v.status_date)
    const current = viewSnapshot
      ? snapshotsDesc.find(v => v.id === viewSnapshot.versionId)
      : snapshotsDesc[0]
    const diffs = current?.changes?.diffs
    if (!Array.isArray(diffs)) return m
    for (const d of diffs as Array<{ task_code: string; reason?: string }>) {
      if (d.reason && d.reason.trim()) m.set(d.task_code, d.reason.trim())
    }
    return m
  }, [versions, viewSnapshot])

  // 点击状态列时显示填报原因的 popover
  const [reasonPopup, setReasonPopup] = useState<{ x: number; y: number; reason: string; taskName: string } | null>(null)
  useEffect(() => {
    if (!reasonPopup) return
    const close = () => setReasonPopup(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [reasonPopup])

  // ── 上一次状态日期快照的 end_date（用于状态列比对） ─────────────────────
  // 取 versions 中"最近的前一次"状态日期快照：若有 >=2 个 status_date 快照，
  // 取第二新的（因为第一新的可能就是当前"确认变更"刚创建的、与当前状态一致）；
  // 若只有一个，用它作为 baseline
  const [latestSnapshotEnds, setLatestSnapshotEnds] = useState<Map<string, string>>(new Map())
  // 上期快照存在的任务 ID 集合（用于检测"本期新增"的任务作为延期根源）
  const [prevSnapshotTaskIds, setPrevSnapshotTaskIds] = useState<Set<string>>(new Set())

  // 用快照 baseline 批量覆盖所有任务的 baseline_end_date，供 computeTaskStatus 检测上游延期用
  const tasksWithSnapshotBaseline = useMemo(() => {
    if (latestSnapshotEnds.size === 0) return tasks
    return tasks.map(t => {
      const be = latestSnapshotEnds.get(t.id)
      return be ? { ...t, baseline_end_date: be } : t
    })
  }, [tasks, latestSnapshotEnds])
  useEffect(() => {
    const snapshots = versions.filter(v => !v.is_autosave && v.status_date)
    // 浏览历史版本时：基线 = 被浏览版本之前的那个状态快照
    // 默认：基线 = 倒数第二个状态快照（首选第二新；若只有一个就用它）
    let baseline: typeof snapshots[number] | undefined
    if (viewSnapshot) {
      const idx = snapshots.findIndex(v => v.id === viewSnapshot.versionId)
      baseline = idx >= 0 ? snapshots[idx + 1] : undefined
    } else {
      baseline = snapshots.length >= 2 ? snapshots[1] : snapshots[0]
    }
    if (!baseline) {
      setLatestSnapshotEnds(new Map())
      setPrevSnapshotTaskIds(new Set())
      return
    }
    let cancelled = false
    authFetch(`/api/versions/${projectId}?id=${baseline.id}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.ok && Array.isArray(d.value?.snapshot?.tasks)) {
          const m = new Map<string, string>()
          const ids = new Set<string>()
          for (const t of d.value.snapshot.tasks as { id: string; end_date: string | null }[]) {
            ids.add(t.id)
            if (t.end_date) m.set(t.id, String(t.end_date).split('T')[0])
          }
          setLatestSnapshotEnds(m)
          setPrevSnapshotTaskIds(ids)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, versions, viewSnapshot])

  const colW = colWProp ?? DEF_COLW
  const prevColWRef = useRef(colW)

  // ── Expand/collapse ────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState<Record<string,boolean>>({})
  useEffect(() => {
    if (!tasks.length) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = true })
    setExpanded(m)
  }, [tasks.length])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Expand / Collapse all signals ──────────────────────────────────────
  useEffect(() => {
    if (!expandAllSignal) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = true })
    setExpanded(m)
  }, [expandAllSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!collapseAllSignal) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = false })
    setExpanded(m)
  }, [collapseAllSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Name editing ───────────────────────────────────────────────────────
  const [editId, setEditId]     = useState<string|null>(null)
  const [editName, setEditName] = useState('')
  const nameInputRef            = useRef<HTMLInputElement>(null)
  const nameCommittedRef        = useRef(false)
  const editNameRef             = useRef(editName)
  editNameRef.current = editName  // always keep ref in sync
  useEffect(() => { if (editId) { nameCommittedRef.current = false; nameInputRef.current?.select() } }, [editId])

  // ── Drag state ─────────────────────────────────────────────────────────
  const [drag, setDrag]           = useState<DragState|null>(null)
  const [previewMap, setPreviewMap] = useState<Record<string,Task>>({})

  // ── 版本对比映射（按 ID 查找对比版本中的任务） ─────────────────────────
  const comparisonMap = useMemo(() => {
    if (!comparison?.tasks?.length) return new Map<string, Task>()
    return new Map(comparison.tasks.map(t => [t.id, t]))
  }, [comparison])

  // 摘要任务集合（有子任务的任务不可直接拖动，日期由子任务决定）
  const summarySet = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => { if (t.parent_id) s.add(t.parent_id) })
    return s
  }, [tasks])

  // 缓存下游任务ID列表，避免重复计算
  const downstreamCache = useMemo(() => {
    const cache = new Map<string, string[]>()
    tasks.forEach(t => {
      cache.set(t.id, getDownstreamIds(t.id, deps))
    })
    return cache
  }, [tasks, deps])

  // ── Dependency connect ─────────────────────────────────────────────────
  const [connect, setConnect]     = useState<ConnectState|null>(null)
  const [hoveredBar, setHoveredBar] = useState<string|null>(null)
  const [selectedDep, setSelectedDep] = useState<string|null>(null)

  // ── Dependency line drag (调整 lag) ────────────────────────────────────
  interface DepDragState {
    depId: string
    startX: number       // mousedown 时的 SVG X 坐标
    startLag: number     // 起始 lag
    deltaDays: number    // 当前拖拽产生的天数差
    labelX: number       // 提示标签 X
    labelY: number       // 提示标签 Y
    dragging: boolean    // 是否进入真正拖拽（移动超过阈值）
  }
  const [depDrag, setDepDrag] = useState<DepDragState|null>(null)
  // 保持一个可转发的 handleDepLagChange 引用，以便在全局 mouseup 中调用（声明顺序靠后）
  const handleDepLagChangeRef = useRef<((depId: string, newLag: number) => Promise<void>) | null>(null)
  // 标记刚结束一次真实拖拽，用于抑制随后的 click 事件
  const depDragJustEndedRef = useRef(false)

  // ── Row reorder drag ────────────────────────────────────────────────────
  const [rowDrag, setRowDrag] = useState<{ taskId: string; startY: number; dragging: boolean }|null>(null)
  const [dropIdx, setDropIdx] = useState<number|null>(null)

  // ── Context menu ────────────────────────────────────────────────────────
  interface CtxMenu { x: number; y: number; taskId: string; submenu: 'add' | 'delete-dep' | 'add-dep' | null; subX?: number; subY?: number }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu|null>(null)

  // ── Cell editing ────────────────────────────────────────────────────────
  interface CellEdit { taskId: string; field: 'assignee' | 'duration' | 'start_date' | 'end_date'; value: string }
  const [cellEdit, setCellEdit] = useState<CellEdit | null>(null)

  // ── Panel resize / collapse ─────────────────────────────────────────────
  const [panelW, setPanelW]           = useState(INIT_LEFT_W)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [splitterDrag, setSplitterDrag] = useState<{ startX: number; startW: number } | null>(null)
  const prevPanelW = useRef(INIT_LEFT_W)

  // ── Name column resize (independent of panel splitter) ──────────────────
  const [nameW, setNameW] = useState(COL_NAME)
  const [nameDrag, setNameDrag] = useState<{ startX: number; startW: number } | null>(null)

  // ── Predecessor popup ────────────────────────────────────────────────────
  const [predPopup, setPredPopup] = useState<{ taskId: string; x: number; y: number } | null>(null)
  const [predFilter, setPredFilter] = useState('')
  const [succPopup, setSuccPopup] = useState<{ taskId: string; x: number; y: number } | null>(null)
  const [succFilter, setSuccFilter] = useState('')
  const [selectedCell, setSelectedCell] = useState<{ taskId: string; col: OptionalCol | 'name' } | null>(null)
  const [activeEditor, setActiveEditor] = useState<{ taskId: string; col: OptionalCol } | null>(null)

  // ── Post-create edit modal ───────────────────────────────────────────────
  const [editModalTaskId, setEditModalTaskId] = useState<string | null>(null)

  // ── Column visibility (from props) ──────────────────────────────────────
  // Dynamic panel width based on visible columns
  const FIXED_COLS_W = useMemo(() =>
    COL_NUM + COL_CHECK + OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).reduce((s, c) => s + c.width, 0),
    [visibleCols])
  const LEFT_W_DYN = useMemo(() => FIXED_COLS_W + COL_NAME, [FIXED_COLS_W])

  // Auto-adjust panel width when visible columns change
  useEffect(() => {
    setPanelW(LEFT_W_DYN)
  }, [LEFT_W_DYN])

  // ── Column sort & filter ────────────────────────────────────────────────
  type SortDir = 'asc' | 'desc' | null
  type SortColK = OptionalCol | null
  const [sortCol, setSortCol] = useState<SortColK>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [colFilters, setColFilters] = useState<Partial<Record<OptionalCol, Set<string>>>>({})
  const [colDropdown, setColDropdown] = useState<OptionalCol | null>(null)
  const colDropdownRef = useRef<HTMLDivElement>(null)

  // 列拖动重排（visibleCols 顺序即渲染顺序，通过 CSS flex order 反映）
  const [draggedCol, setDraggedCol] = useState<OptionalCol | null>(null)
  const [dragOverCol, setDragOverCol] = useState<OptionalCol | null>(null)
  const colOrderMap = useMemo(() => {
    const m = new Map<OptionalCol, number>()
    visibleCols.forEach((k, i) => m.set(k, i))
    return m
  }, [visibleCols])
  const colOrderOf = useCallback((k: OptionalCol) => colOrderMap.get(k) ?? 999, [colOrderMap])
  const handleColReorder = useCallback((fromKey: OptionalCol, toKey: OptionalCol) => {
    if (fromKey === toKey || !onVisibleColsChange) return
    const next = visibleCols.filter(k => k !== fromKey)
    const idx = next.indexOf(toKey)
    if (idx === -1) return
    next.splice(idx, 0, fromKey)
    onVisibleColsChange(next)
  }, [visibleCols, onVisibleColsChange])

  const toggleSort = useCallback((col: OptionalCol) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc')
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null) }
      else setSortDir('asc')
    } else {
      setSortCol(col); setSortDir('asc')
    }
  }, [sortCol, sortDir])

  // 关闭列下拉菜单
  useEffect(() => {
    if (!colDropdown) return
    const close = (e: MouseEvent) => {
      if (colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) setColDropdown(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [colDropdown])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [ctxMenu])

  useEffect(() => {
    if (!predPopup) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPredPopup(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [predPopup])

  useEffect(() => {
    if (!succPopup) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSuccPopup(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [succPopup])

  const svgRef         = useRef<SVGSVGElement>(null)
  const leftRef        = useRef<HTMLDivElement>(null)
  const rightRef       = useRef<HTMLDivElement>(null)
  const rightHeaderRef = useRef<HTMLDivElement>(null)
  const scrollHLock    = useRef(false)

  // 测量右侧面板水平滚动条高度，用于左侧面板底部补偿
  const [hScrollbarH, setHScrollbarH] = useState(0)
  useEffect(() => {
    const el = rightRef.current
    if (!el) return
    const measure = () => setHScrollbarH(el.offsetHeight - el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const syncTimelineScrollLeft = useCallback((sl: number) => {
    scrollHLock.current = true
    if (rightRef.current) rightRef.current.scrollLeft = sl
    if (rightHeaderRef.current) rightHeaderRef.current.scrollLeft = sl
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  // ── Zoom: keep viewport center stable ─────────────────────────────────
  // 用 ref 缓存任务日期范围（天数偏移），避免声明顺序问题
  const taskRangeRef = useRef<{ minDay: number; maxDay: number; totalDays: number }>({ minDay: 0, maxDay: 60, totalDays: 60 })

  // ── Sync scroll: vertical sync between left and right panels ──
  const scrollVLock = useRef(false)

  const onLeftBodyScroll = useCallback(() => {
    if (scrollVLock.current) return
    if (!leftRef.current || !rightRef.current) return
    scrollVLock.current = true
    rightRef.current.scrollTop = leftRef.current.scrollTop
    requestAnimationFrame(() => { scrollVLock.current = false })
  }, [])

  const onRightBodyScroll = useCallback(() => {
    if (!rightRef.current || !leftRef.current) return
    if (!scrollVLock.current) {
      scrollVLock.current = true
      leftRef.current.scrollTop = rightRef.current.scrollTop
      requestAnimationFrame(() => { scrollVLock.current = false })
    }
    if (scrollHLock.current) return
    scrollHLock.current = true
    if (rightHeaderRef.current)
      rightHeaderRef.current.scrollLeft = rightRef.current.scrollLeft
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  const onRightHeaderScroll = useCallback(() => {
    if (!rightHeaderRef.current || !rightRef.current) return
    if (scrollHLock.current) return
    scrollHLock.current = true
    rightRef.current.scrollLeft = rightHeaderRef.current.scrollLeft
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  // ── Flat row list ───────────────────────────────────────────────────────
  const flatRows = useMemo((): FlatRow[] => {
    const kids: Record<string,Task[]> = {}
    tasks.forEach(t => {
      // 防止自引用
      if (t.parent_id === t.id) { if (!kids['__root__']) kids['__root__']=[]; kids['__root__'].push(t); return }
      const k = t.parent_id ?? '__root__'
      if (!kids[k]) kids[k]=[]
      kids[k].push(t)
    })
    const rows: FlatRow[] = []
    const visited = new Set<string>()
    function walk(pid: string|null, lvl: number) {
      const key = pid ?? '__root__'
      ;(kids[key]??[]).sort((a,b)=>a.order_index-b.order_index).forEach(t => {
        if (visited.has(t.id)) return // 防止循环引用
        visited.add(t.id)
        const has = !!(kids[t.id]?.length)
        rows.push({ task:t, level:lvl, hasChildren:has, expanded:expanded[t.id]??true })
        if (has && (expanded[t.id]??true)) walk(t.id, lvl+1)
      })
    }
    walk(null,0)
    return rows
  }, [tasks, expanded])

  // ── WBS numbering + sequential index ─────────────────────────────────────
  const { wbsMap, seqMap } = useMemo(() => {
    const wbs = new Map<string, string>()
    const seq = new Map<string, number>()
    const kids: Record<string, Task[]> = {}
    tasks.forEach(t => {
      const k = (t.parent_id && t.parent_id !== t.id) ? t.parent_id : '__root__'
      if (!kids[k]) kids[k] = []
      kids[k].push(t)
    })
    let counter = 0
    const visited = new Set<string>()
    function walk(pid: string | null, prefix: string) {
      const key = pid ?? '__root__'
      const sorted = (kids[key] ?? []).slice().sort((a, b) => a.order_index - b.order_index)
      sorted.forEach((t, i) => {
        if (visited.has(t.id)) return
        visited.add(t.id)
        const w = prefix ? `${prefix}.${i + 1}` : String(i + 1)
        wbs.set(t.id, w)
        seq.set(t.id, ++counter)
        walk(t.id, w)
      })
    }
    walk(null, '')
    return { wbsMap: wbs, seqMap: seq }
  }, [tasks])

  // ── Date range ──────────────────────────────────────────────────────────
  const { origin, totalDays } = useMemo(() => {
    if (!tasks.length) {
      const o=sod(new Date()); o.setDate(o.getDate()-o.getDay())
      return { origin:o, totalDays:60 }
    }
    let mn=new Date(9999,0,1), mx=new Date(2000,0,1)
    tasks.forEach(t=>{
      if (t.start_date){const d=new Date(t.start_date); if(d<mn)mn=d}
      if (t.end_date)  {const d=new Date(t.end_date);   if(d>mx)mx=d}
    })
    if (currentProject?.start_date) { const d=new Date(currentProject.start_date); if(d<mn)mn=d }
    if (currentProject?.end_date)   { const d=new Date(currentProject.end_date);   if(d>mx)mx=d }
    const o=sod(mn); o.setDate(o.getDate()-o.getDay()-60)
    return { origin:o, totalDays:diffDays(o, addDays(sod(mx),21)) }
  }, [tasks, currentProject?.start_date, currentProject?.end_date])

  // 像素/分钟：colW 是像素/天，1440 分钟/天。分钟级精度由此派生。
  const pxPerMin = colW / 1440
  const dateToX = useCallback((d:Date)=>diffMins(origin,d)*pxPerMin, [origin, pxPerMin])

  // ── 更新任务日期范围缓存 + 缩放居中 ────────────────────────────────────
  useEffect(() => {
    let mn = Infinity, mx = -Infinity
    tasks.forEach(t => {
      if (t.start_date) { const d = diffDays(origin, new Date(t.start_date)); if (d < mn) mn = d }
      if (t.end_date)   { const d = diffDays(origin, new Date(t.end_date));   if (d > mx) mx = d }
    })
    taskRangeRef.current = { minDay: mn === Infinity ? 0 : mn, maxDay: mx === -Infinity ? totalDays : mx, totalDays }
  }, [tasks, origin, totalDays])

  useEffect(() => {
    const prev = prevColWRef.current
    if (prev === colW) return
    prevColWRef.current = colW
    const el = rightRef.current
    if (!el) return
    const viewW = el.clientWidth
    // 缩放时保持状态日期（或今天）居中
    const target = statusDate ? new Date(statusDate) : sod(new Date())
    const targetX = diffDays(origin, target) * colW
    syncTimelineScrollLeft(Math.max(0, targetX - viewW / 2))
  }, [colW, syncTimelineScrollLeft, statusDate, origin])

  // ── Initial scroll: center on status date or today ─────────────────────
  const scrolledForProject = useRef<string>('')
  useEffect(() => {
    if (scrolledForProject.current === projectId || !tasks.length) return
    // statusDate === undefined means project data hasn't loaded yet; wait for it
    if (statusDate === undefined) return
    scrolledForProject.current = projectId
    const target = statusDate ? new Date(statusDate) : sod(new Date())
    const x = dateToX(target)
    requestAnimationFrame(() => {
      const vw = rightRef.current?.clientWidth ?? 600
      syncTimelineScrollLeft(Math.max(0, x - vw / 3))
    })
  }, [tasks.length, statusDate, dateToX, syncTimelineScrollLeft, projectId])

  // ── Display rows: apply previewMap + search filter ──────────────────────
  const displayRows = useMemo((): FlatRow[] => {
    const withPreview = Object.keys(previewMap).length
      ? flatRows.map(r => previewMap[r.task.id] ? { ...r, task: previewMap[r.task.id] } : r)
      : flatRows
    let rows = withPreview

    // 安全地向上遍历祖先链并加入 matched，防止循环引用
    const addAncestors = (t: Task, matched: Set<string>) => {
      const seen = new Set<string>()
      let cur: Task | undefined = t
      while (cur?.parent_id) {
        if (matched.has(cur.parent_id) || seen.has(cur.parent_id)) break
        seen.add(cur.parent_id)
        matched.add(cur.parent_id)
        cur = tasks.find(x => x.id === cur!.parent_id)
      }
    }

    // 搜索过滤
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matched = new Set<string>()
      tasks.forEach(t => {
        if (t.name.toLowerCase().includes(q)) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 列筛选（多列并列）
    const activeFilterEntries = Object.entries(colFilters).filter(([, v]) => v && (v as Set<string>).size > 0) as [OptionalCol, Set<string>][]
    if (activeFilterEntries.length > 0) {
      const sdForStatus = statusDate ? new Date(statusDate) : null
      const byIdForStatus = new Map(tasksWithSnapshotBaseline.map(x => [x.id, x] as const))
      const statusCtx = { allTasks: tasksWithSnapshotBaseline, deps, prevTaskIds: prevSnapshotTaskIds }
      const statusValue = (t: Task): string => {
        const st = computeTaskStatus(byIdForStatus.get(t.id) ?? t, sdForStatus, statusCtx).status
        const isNewTask = prevSnapshotTaskIds.size > 0 && !prevSnapshotTaskIds.has(t.id)
        if (isNewTask && (st === 'notstarted' || st === 'started' || st === 'completed')) return `new:${st}`
        return st
      }
      const colVal = (t: Task, k: OptionalCol): string => {
        switch (k) {
          case 'assignee':   return t.assignee ?? ''
          case 'pct':        return String(t.percent_done ?? 0)
          case 'duration':   return String(t.duration ?? '')
          case 'start':      return (t.start_date ?? '').split('T')[0]
          case 'end':        return (t.end_date ?? '').split('T')[0]
          case 'pred':       return deps.filter(d => d.to_task_id === t.id).length > 0 ? '有' : '无'
          case 'succ':       return deps.filter(d => d.from_task_id === t.id).length > 0 ? '有' : '无'
          case 'lag':        { const d = deps.find(x => x.to_task_id === t.id); return d ? String(d.lag ?? 0) : '' }
          case 'ctype':      return t.constraint_type ?? 'asap'
          case 'cdate':      return (t.constraint_date ?? '').split('T')[0]
          case 'ddate':      return (t.deadline ?? '').split('T')[0]
          case 'status':     return statusValue(t)
          case 'inactive':   return t.inactive ? '是' : '否'
        }
      }
      const matched = new Set<string>()
      tasks.forEach(t => {
        const pass = activeFilterEntries.every(([k, set]) => set.has(colVal(t, k)))
        if (pass) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 差异筛选：只显示版本对比中变更的任务
    if (diffFilter?.taskCodes?.length) {
      const codes = new Set(diffFilter.taskCodes)
      const matched = new Set<string>()
      tasks.forEach(t => {
        if (codes.has(t.task_code)) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 排序（保持树形结构：仅对同层级兄弟排序）
    if (sortCol && sortDir) {
      const getSortVal = (t: Task): number | string => {
        switch (sortCol) {
          case 'assignee':   return t.assignee ?? ''
          case 'pct':        return t.percent_done ?? 0
          case 'duration':   return t.duration ?? 0
          case 'start':      return t.start_date ?? ''
          case 'end':        return t.end_date ?? ''
          case 'pred':       return deps.filter(d => d.to_task_id === t.id).length
          case 'succ':       return deps.filter(d => d.from_task_id === t.id).length
          case 'lag':        { const d = deps.find(x => x.to_task_id === t.id); return d?.lag ?? 0 }
          case 'ctype':      return t.constraint_type ?? ''
          case 'cdate':      return t.constraint_date ?? ''
          case 'ddate':      return t.deadline ?? ''
          case 'status':     return t.status ?? ''
          default:           return 0
        }
      }
      const cmp = (a: Task, b: Task): number => {
        const va = getSortVal(a), vb = getSortVal(b)
        const r = typeof va === 'number' && typeof vb === 'number'
          ? va - vb : String(va).localeCompare(String(vb))
        return sortDir === 'desc' ? -r : r
      }
      // 按父 id 分桶，同父兄弟内部排序，再按树形结构重建
      const byParent = new Map<string | null, FlatRow[]>()
      rows.forEach(r => {
        const p = r.task.parent_id ?? null
        if (!byParent.has(p)) byParent.set(p, [])
        byParent.get(p)!.push(r)
      })
      byParent.forEach(arr => arr.sort((a, b) => cmp(a.task, b.task)))
      const rebuilt: FlatRow[] = []
      const emit = (parentId: string | null) => {
        const siblings = byParent.get(parentId) ?? []
        for (const r of siblings) {
          rebuilt.push(r)
          emit(r.task.id)
        }
      }
      emit(null)
      return rebuilt
    }

    return rows
  }, [flatRows, previewMap, searchQuery, tasks, deps, colFilters, diffFilter, sortCol, sortDir, statusDate])

  // ── Row index map (based on displayed rows for arrow positioning) ────────
  const rowIdx = useMemo(() => {
    const m: Record<string,number>={}
    displayRows.forEach((r,i)=>{ m[r.task.id]=i })
    return m
  }, [displayRows])

  // ── 序号 map for predecessor display（覆盖所有任务） ────
  const flatRowIdx = useMemo(() => {
    const m: Record<string, string> = {}
    for (const [id, num] of seqMap) {
      m[id] = String(num)
    }
    return m
  }, [seqMap])

  // ── Project start date（用于"空"类型任务的自动对齐）──────────────────────
  const projectStartDate = useMemo(() => {
    if (currentProject?.start_date) return currentProject.start_date.split('T')[0]
    // Fallback: earliest task start date
    const starts = tasks.filter(t => t.start_date).map(t => new Date(t.start_date!))
    if (starts.length === 0) return fmtDate(sod(new Date()))
    return fmtDate(new Date(Math.min(...starts.map(x => x.getTime()))))
  }, [currentProject?.start_date, tasks])

  const defaultStart = useMemo(() => {
    let d = new Date(projectStartDate)
    if (statusDate) {
      const sd = new Date(statusDate)
      if (sd > d) d = sd
    }
    return fmtDate(d)
  }, [projectStartDate, statusDate])

  // ── 关键路径计算（正推 + 反推，浮动=0 的任务即为关键路径） ─────────────────
  const inactiveSet = useMemo((): Set<string> => {
    const byId = new Map(tasks.map(t => [t.id, t] as const))
    const cache = new Map<string, boolean>()
    const check = (id: string): boolean => {
      if (cache.has(id)) return cache.get(id)!
      const t = byId.get(id); if (!t) { cache.set(id, false); return false }
      const v = !!t.inactive || (t.parent_id ? check(t.parent_id) : false)
      cache.set(id, v); return v
    }
    const s = new Set<string>()
    tasks.forEach(t => { if (check(t.id)) s.add(t.id) })
    return s
  }, [tasks])

  const criticalSet = useMemo((): Set<string> => {
    if (!showCriticalPath) return new Set()

    // 只考虑叶子任务（非摘要）且有完整日期
    const leafTasks = tasks.filter(t =>
      t.start_date && t.end_date && t.duration != null && !summarySet.has(t.id)
    )
    if (leafTasks.length === 0) return new Set()

    // 构建任务信息映射
    const info = new Map<string, { dur: number; es: number; ef: number; ls: number; lf: number }>()
    for (const t of leafTasks) {
      info.set(t.id, { dur: t.duration ?? 0, es: 0, ef: 0, ls: 0, lf: 0 })
    }

    // 前置依赖和后继依赖索引
    const preds = new Map<string, Array<{ fromId: string; type: number; lag: number }>>()
    const succs = new Map<string, Array<{ toId: string; type: number; lag: number }>>()
    for (const d of deps) {
      if (!info.has(d.from_task_id) || !info.has(d.to_task_id)) continue
      if (!preds.has(d.to_task_id)) preds.set(d.to_task_id, [])
      preds.get(d.to_task_id)!.push({ fromId: d.from_task_id, type: d.type ?? 2, lag: d.lag ?? 0 })
      if (!succs.has(d.from_task_id)) succs.set(d.from_task_id, [])
      succs.get(d.from_task_id)!.push({ toId: d.to_task_id, type: d.type ?? 2, lag: d.lag ?? 0 })
    }

    // 拓扑排序（基于依赖关系）
    const inDegree = new Map<string, number>()
    for (const id of info.keys()) inDegree.set(id, 0)
    for (const [toId, predList] of preds) {
      inDegree.set(toId, predList.length)
    }
    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }
    const topoOrder: string[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      topoOrder.push(cur)
      for (const s of (succs.get(cur) ?? [])) {
        const nd = (inDegree.get(s.toId) ?? 1) - 1
        inDegree.set(s.toId, nd)
        if (nd === 0) queue.push(s.toId)
      }
    }

    // 正推（Forward Pass）：计算 ES, EF
    for (const id of topoOrder) {
      const t = info.get(id)!
      let es = 0
      for (const p of (preds.get(id) ?? [])) {
        const pi = info.get(p.fromId)!
        let required = 0
        if (p.type === 2)      required = pi.ef + p.lag        // FS
        else if (p.type === 0) required = pi.es + p.lag        // SS
        else if (p.type === 3) required = pi.ef + p.lag - t.dur // FF
        else if (p.type === 1) required = pi.es + p.lag - t.dur // SF
        if (required > es) es = required
      }
      t.es = es
      t.ef = es + t.dur
    }

    // 项目最晚结束时间
    let projectEnd = 0
    for (const t of info.values()) {
      if (t.ef > projectEnd) projectEnd = t.ef
    }

    // 反推（Backward Pass）：计算 LS, LF
    // 无后继任务：LF = projectEnd（项目最晚结束时间）
    // 有后继任务：LF 由后继约束决定，初始化为 Infinity 以便后续取最小值
    const tasksWithSuccessors = new Set<string>()
    for (const [id] of succs) {
      if ((succs.get(id) ?? []).length > 0) tasksWithSuccessors.add(id)
    }
    for (const [id, t] of info) {
      if (tasksWithSuccessors.has(id)) {
        t.lf = Infinity
        t.ls = Infinity
      } else {
        t.lf = projectEnd
        t.ls = projectEnd - t.dur
      }
    }
    for (let i = topoOrder.length - 1; i >= 0; i--) {
      const id = topoOrder[i]
      const t = info.get(id)!
      for (const s of (succs.get(id) ?? [])) {
        const si = info.get(s.toId)!
        let constraint = projectEnd
        if (s.type === 2)      constraint = si.ls - s.lag        // FS: LF_pred <= LS_succ - lag
        else if (s.type === 0) constraint = si.ls - s.lag + t.dur // SS: LS_pred <= LS_succ - lag
        else if (s.type === 3) constraint = si.lf - s.lag        // FF: LF_pred <= LF_succ - lag
        else if (s.type === 1) constraint = si.lf - s.lag + t.dur // SF: LS_pred <= LF_succ - lag
        if (constraint < t.lf) {
          t.lf = constraint
          t.ls = t.lf - t.dur
        }
      }
    }

    // 浮动 = LS - ES，浮动为 0 的任务在关键路径上
    const result = new Set<string>()
    for (const [id, t] of info) {
      const totalFloat = t.ls - t.es
      if (Math.abs(totalFloat) < 0.001) result.add(id)
    }
    return result
  }, [showCriticalPath, tasks, deps, summarySet])

  // ── 摘要任务进度（所有后代叶子任务按工期加权的完成度） ──────────────
  const statusDateObj = useMemo(() => statusDate ? new Date(statusDate) : null, [statusDate])
  const summaryProgressMap = useMemo(() => {
    const map = new Map<string, number>()
    if (summarySet.size === 0) return map
    // 收集每个摘要任务的所有后代叶子（防止循环引用）
    function getLeafDescendants(parentId: string, visited?: Set<string>): Task[] {
      const seen = visited ?? new Set<string>()
      if (seen.has(parentId)) return []
      seen.add(parentId)
      const leaves: Task[] = []
      const children = tasks.filter(t => t.parent_id === parentId && !t.is_deleted)
      for (const c of children) {
        if (summarySet.has(c.id)) {
          leaves.push(...getLeafDescendants(c.id, seen))
        } else {
          leaves.push(c)
        }
      }
      return leaves
    }
    for (const sid of summarySet) {
      const leaves = getLeafDescendants(sid)
      if (leaves.length === 0) { map.set(sid, 0); continue }
      let totalDur = 0, weightedSum = 0
      for (const t of leaves) {
        const dur = t.duration ?? 1
        totalDur += dur
        weightedSum += dur * timeBasedPercent(t, statusDateObj)
      }
      map.set(sid, totalDur > 0 ? Math.round(weightedSum / totalDur) : 0)
    }
    return map
  }, [tasks, summarySet, statusDateObj])


  // ── SVG mouse position helper ───────────────────────────────────────────
  const getSvgX = useCallback((clientX:number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    return rect ? clientX - rect.left : 0
  }, [])

  // ── Focus on selected task ──────────────────────────────────────────────
  useEffect(() => {
    if (!focusSignal || selectedIds.length === 0) return
    const taskId = selectedIds[0]
    const rowI = rowIdx[taskId]
    if (rowI !== undefined && leftRef.current)
      leftRef.current.scrollTop = Math.max(0, rowI * ROW_H - 80)
    const task = tasks.find(t => t.id === taskId)
    if (task?.start_date && rightRef.current) {
      const x = dateToX(new Date(task.start_date))
      syncTimelineScrollLeft(Math.max(0, x - 200))
    }
  }, [focusSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bar drag: mousedown ─────────────────────────────────────────────────
  const onBarMouseDown = useCallback((e: React.MouseEvent, task: Task) => {
    if (readOnly) return
    if (!task.start_date || !task.end_date) return
    e.stopPropagation(); e.preventDefault()
    setSelectedDep(null)

    const isSummary = summarySet.has(task.id)

    // 摘要任务只允许整体平移（move），不允许 resize
    let mode: DragMode = 'move'
    if (!isSummary) {
      // 根据鼠标位置判断操作类型（扩大边缘热区到15px）
      const taskX = dateToX(new Date(task.start_date))
      const taskW = dateToX(new Date(task.end_date)) - taskX
      const mouseX = getSvgX(e.clientX)
      const EDGE_SIZE = 15

      // 短条（宽度不足 2*EDGE_SIZE）：整体平移，不做 resize
      if (taskW > EDGE_SIZE * 2) {
        if (mouseX < taskX + EDGE_SIZE) {
          mode = 'resize-left'
        } else if (mouseX > taskX + taskW - EDGE_SIZE) {
          mode = 'resize-right'
        }
      }

      // auto_schedule 任务根据依赖类型限制拖动方向（无依赖则不限制）
      if (task.auto_schedule !== false) {
        const incoming = deps.filter(d => d.to_task_id === task.id)
        if (incoming.length > 0) {
          const depType = incoming[0].type ?? 2
          if (depType === 3 || depType === 1) {
            if (mode !== 'resize-left') return
          } else {
            if (mode !== 'resize-right') return
          }
        }
      }
    }

    setDrag({
      taskId: task.id, mode,
      startMouseX: getSvgX(e.clientX),
      origStart: new Date(task.start_date),
      origEnd:   new Date(task.end_date),
      dragging: false,
    })
    setPreviewMap({ [task.id]: { ...task } })
  }, [getSvgX, dateToX, summarySet, deps, readOnly])

  // ── Connect handle: mousedown ───────────────────────────────────────────
  const onConnectMouseDown = useCallback((e: React.MouseEvent, task: Task, rowI: number) => {
    if (readOnly) return
    if (!task.end_date) return
    // 父级任务不允许依赖
    if (summarySet.has(task.id)) return
    e.stopPropagation(); e.preventDefault()
    const x = dateToX(new Date(task.end_date))
    const y = rowI * ROW_H + ROW_H / 2
    setConnect({ fromTaskId: task.id, fromX:x, fromY:y, curX:x, curY:y })
  }, [dateToX, summarySet, readOnly])

  // ── Row drag handle: mousedown ──────────────────────────────────────────
  const onRowDragStart = useCallback((e: React.MouseEvent, taskId: string) => {
    if (readOnly) return
    // 不阻止默认行为和冒泡，让 click 事件能正常触发（选中行）
    // 只记录拖动起点，超过阈值后才真正进入拖动模式
    setRowDrag({ taskId, startY: e.clientY, dragging: false })
  }, [readOnly])

  // ── Escape 取消拖拽 ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (drag || connect)) {
        setDrag(null)
        setPreviewMap({})
        setConnect(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drag, connect])

  // ── 节流函数：限制setState频率，trailing 确保最后一帧一定生效 ──────────
  const throttleTimer = useRef<NodeJS.Timeout | null>(null)
  const pendingPreview = useRef<Record<string, Task> | null>(null)
  const throttledSetPreview = useCallback((map: Record<string, Task>) => {
    pendingPreview.current = map
    if (throttleTimer.current) return
    setPreviewMap(map)
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null
      // flush latest pending value so the last frame is never dropped
      if (pendingPreview.current) {
        setPreviewMap(pendingPreview.current)
        pendingPreview.current = null
      }
    }, 16) // 60fps
  }, [])

  // ── Global mousemove ────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const svgX = getSvgX(e.clientX)

      if (drag) {
        const dx = svgX - drag.startMouseX

        // 只有鼠标移动超过4像素才开始真正拖动
        if (!drag.dragging && Math.abs(dx) > 4) {
          setDrag(prev => prev ? { ...prev, dragging: true } : null)
        }

        // 只有在真正拖动时才更新日期（分钟级精度，吸附到 15 分钟）
        if (drag.dragging) {
          const minsRaw = Math.round(dx * 1440 / colW)
          // 天级项目吸附 1 天 (1440 min)，分钟级吸附 15 分钟。
          const snap = isMinute ? SNAP_MIN : 1440
          const mins = Math.round(minsRaw / snap) * snap
          const days = mins / 1440
          const orig = tasks.find(t => t.id === drag.taskId)
          if (!orig) return

          const isSummaryDrag = summarySet.has(drag.taskId)

          // ── 摘要任务拖动：整体平移所有后代 ──
          if (isSummaryDrag) {
            const descendantIds = getDescendantIds(drag.taskId, tasks)
            const descendantSet = new Set(descendantIds)
            const effectiveDays = days

            const map: Record<string, Task> = {}
            const localStart = new Map<string, Date>()
            const localEnd   = new Map<string, Date>()

            // 初始化所有任务的原始日期
            tasks.forEach(t => {
              if (t.start_date) localStart.set(t.id, new Date(t.start_date))
              if (t.end_date)   localEnd.set(t.id, new Date(t.end_date))
            })

            // 平移所有后代
            for (const did of descendantIds) {
              const dt = tasks.find(t => t.id === did)
              if (!dt?.start_date || !dt?.end_date) continue
              const s = addDays(new Date(dt.start_date), effectiveDays)
              const e = addDays(new Date(dt.end_date), effectiveDays)
              localStart.set(did, s)
              localEnd.set(did, e)
              map[did] = { ...dt, start_date: fmtDt(s), end_date: fmtDt(e), duration: diffMins(s, e) }
            }

            // 级联子树外部的下游依赖
            // 收集子树中所有任务的下游（排除子树内部的）
            const externalDownstream = new Set<string>()
            for (const did of descendantIds) {
              const ds = downstreamCache.get(did) || []
              for (const d of ds) {
                if (!descendantSet.has(d)) externalDownstream.add(d)
              }
            }
            const extIds = [...externalDownstream]
            let changed = true, iter = 0
            while (changed && iter++ < extIds.length + 1) {
              changed = false
              for (const toId of extIds) {
                const t = tasks.find(x => x.id === toId)
                if (!t || !t.start_date || !t.end_date) continue
                const incoming = deps.filter(d => d.to_task_id === toId)
                if (incoming.length === 0 && t.auto_schedule === false) continue
                let maxRS: Date | null = null
                for (const dep of incoming) {
                  const pS = localStart.get(dep.from_task_id)
                  const pE = localEnd.get(dep.from_task_id)
                  if (!pS || !pE) continue
                  const lag = dep.lag ?? 0
                  const dt2 = dep.type ?? 2
                  let rs: Date
                  if (dt2 === 2)      rs = addDays(pE, lag)
                  else if (dt2 === 0) rs = addDays(pS, lag)
                  else if (dt2 === 3) { const dur = diffDays(localStart.get(toId)!, localEnd.get(toId)!); rs = addDays(pE, lag - dur) }
                  else                { const dur = diffDays(localStart.get(toId)!, localEnd.get(toId)!); rs = addDays(pS, lag - dur) }
                  if (!maxRS || rs > maxRS) maxRS = rs
                }
                if (!maxRS) continue
                const curS = localStart.get(toId)!
                if (curS.getTime() === maxRS.getTime()) continue
                const shift = diffDays(curS, maxRS)
                const s = addDays(curS, shift)
                let eNew = addDays(localEnd.get(toId)!, shift)
                if (t.is_milestone) eNew = s
                if (eNew < s) eNew = s
                localStart.set(toId, s)
                localEnd.set(toId, eNew)
                map[toId] = { ...t, start_date: fmtDt(s), end_date: fmtDt(eNew), duration: diffMins(s, eNew) }
                changed = true
              }
            }

            // 更新摘要任务日期（包括被拖的摘要任务本身及其祖先）
            const refreshSummary = (pid: string | null) => {
              const seen = new Set<string>()
              let curPid = pid
              while (curPid && !seen.has(curPid)) {
                seen.add(curPid)
                const children = tasks.filter(c => c.parent_id === curPid)
                if (children.length === 0) break
                let minS: string | null = null, maxE: string | null = null
                for (const c of children) {
                  const ct = map[c.id] ?? c
                  const s = ct.start_date ?? null
                  const e2 = ct.end_date ?? null
                  if (s && (!minS || s < minS)) minS = s
                  if (e2 && (!maxE || e2 > maxE)) maxE = e2
                }
                if (minS && maxE) {
                  const p = tasks.find(x => x.id === curPid)
                  if (p) map[curPid] = { ...p, start_date: minS, end_date: maxE, duration: diffMins(new Date(minS), new Date(maxE)) }
                }
                curPid = tasks.find(x => x.id === curPid)?.parent_id ?? null
              }
            }
            // 从被拖摘要任务开始往上刷新
            refreshSummary(drag.taskId)
            // 从外部级联影响到的任务的父级也刷新
            for (const id of Object.keys(map)) {
              const tk = tasks.find(x => x.id === id)
              if (tk?.parent_id && !descendantSet.has(tk.parent_id) && tk.parent_id !== drag.taskId) {
                refreshSummary(tk.parent_id)
              }
            }

            throttledSetPreview(map)
          } else {
          // ── 普通叶子任务拖动（原有逻辑） ──
          let newStart = drag.origStart, newEnd = drag.origEnd
          let cascadeDays = days

          if (drag.mode === 'move') {
            newStart = addDays(drag.origStart, days)
            newEnd   = addDays(drag.origEnd,   days)
            cascadeDays = diffDays(drag.origStart, newStart)
          } else if (drag.mode === 'resize-right') {
            newEnd = addDays(drag.origEnd, days)
            if (newEnd <= newStart) newEnd = addDays(newStart, 1)
            cascadeDays = diffDays(drag.origEnd, newEnd)
          } else if (drag.mode === 'resize-left') {
            newStart = addDays(drag.origStart, days)
            if (newStart >= newEnd) newStart = addDays(newEnd, -1)
            cascadeDays = 0
          }

          const map: Record<string, Task> = {
            [orig.id]: {
              ...orig,
              start_date: fmtDt(newStart),
              end_date:   fmtDate(newEnd),
              duration:   diffDays(newStart, newEnd),
            },
          }

          // ── 级联更新：迭代式处理所有依赖类型(SS/SF/FS/FF)和传递链 ──
          const localStart = new Map<string, Date>()
          const localEnd   = new Map<string, Date>()
          localStart.set(drag.taskId, newStart)
          localEnd.set(drag.taskId, newEnd)
          tasks.forEach(t => {
            if (t.start_date && !localStart.has(t.id)) localStart.set(t.id, new Date(t.start_date))
            if (t.end_date && !localEnd.has(t.id))     localEnd.set(t.id, new Date(t.end_date))
          })

          const downstreamIds = downstreamCache.get(drag.taskId) || []
          let changed = true, iter = 0
          while (changed && iter++ < downstreamIds.length + 1) {
            changed = false
            for (const toId of downstreamIds) {
              const t = tasks.find(x => x.id === toId)
              if (!t || !t.start_date || !t.end_date) continue

              const incoming = deps.filter(d => d.to_task_id === toId)
              if (incoming.length === 0 && t.auto_schedule === false) continue
              let maxRequiredStart: Date | null = null

              for (const dep of incoming) {
                const predStart = localStart.get(dep.from_task_id)
                const predEnd   = localEnd.get(dep.from_task_id)
                if (!predStart || !predEnd) continue
                const lag = dep.lag ?? 0
                const depType = dep.type ?? 2

                let requiredStart: Date
                if (depType === 2) {
                  requiredStart = addDays(predEnd, lag)
                } else if (depType === 0) {
                  requiredStart = addDays(predStart, lag)
                } else if (depType === 3) {
                  const curS = localStart.get(toId)!
                  const curE = localEnd.get(toId)!
                  const dur = diffDays(curS, curE)
                  requiredStart = addDays(predEnd, lag - dur)
                } else {
                  const curS = localStart.get(toId)!
                  const curE = localEnd.get(toId)!
                  const dur = diffDays(curS, curE)
                  requiredStart = addDays(predStart, lag - dur)
                }

                if (!maxRequiredStart || requiredStart > maxRequiredStart) {
                  maxRequiredStart = requiredStart
                }
              }

              if (!maxRequiredStart) continue

              const curStart = localStart.get(toId)!
              if (curStart.getTime() === maxRequiredStart.getTime()) continue
              {
                const shift = diffDays(curStart, maxRequiredStart)
                const s = addDays(curStart, shift)
                let e = addDays(localEnd.get(toId)!, shift)
                if (t.is_milestone) e = s
                if (e < s) e = s
                localStart.set(toId, s)
                localEnd.set(toId, e)
                map[toId] = { ...t, start_date: fmtDt(s), end_date: fmtDt(e), duration: diffMins(s, e) }
                changed = true
              }
            }
          }

          // ── 更新摘要任务（父任务）日期范围 ──
          const affectedParents = new Set<string>()
          for (const id of Object.keys(map)) {
            const tk = tasks.find(x => x.id === id)
            if (tk?.parent_id) affectedParents.add(tk.parent_id)
          }
          for (const pid of affectedParents) {
            let curPid: string | null = pid
            const seen = new Set<string>()
            while (curPid && !seen.has(curPid)) {
              seen.add(curPid)
              const children = tasks.filter(c => c.parent_id === curPid)
              if (children.length === 0) break
              let minS: string | null = null
              let maxE: string | null = null
              for (const c of children) {
                const ct = map[c.id] ?? c
                const s = ct.start_date ?? null
                const e2 = ct.end_date ?? null
                if (s && (!minS || s < minS)) minS = s
                if (e2 && (!maxE || e2 > maxE)) maxE = e2
              }
              if (minS && maxE) {
                const parent = tasks.find(x => x.id === curPid)
                if (parent) {
                  map[curPid] = {
                    ...parent,
                    start_date: minS,
                    end_date: maxE,
                    duration: diffMins(new Date(minS), new Date(maxE)),
                  }
                }
              }
              curPid = tasks.find(x => x.id === curPid)?.parent_id ?? null
            }
          }

          throttledSetPreview(map)
          } // end else (非摘要任务)
        }
      }

      if (connect) {
        const rect = svgRef.current?.getBoundingClientRect()
        const y = rect ? e.clientY - rect.top : connect.curY
        setConnect(prev => prev ? { ...prev, curX:svgX, curY:y } : null)
      }

      if (rowDrag) {
        if (!rowDrag.dragging && Math.abs(e.clientY - rowDrag.startY) > 4)
          setRowDrag(prev => prev ? { ...prev, dragging: true } : null)
        if (rowDrag.dragging) {
          const rect = leftRef.current?.getBoundingClientRect()
          if (rect) {
            const rel = e.clientY - rect.top + (leftRef.current?.scrollTop ?? 0)
            setDropIdx(Math.min(Math.max(0, Math.round(rel / ROW_H)), displayRows.length))
          }
        }
      }

      if (splitterDrag) {
        const newW = Math.max(COL_NUM + COL_CHECK + nameW, Math.min(900, splitterDrag.startW + e.clientX - splitterDrag.startX))
        setPanelW(newW)
        if (panelCollapsed) setPanelCollapsed(false)
      }

      if (nameDrag) {
        const delta = e.clientX - nameDrag.startX
        const maxNameW = (panelCollapsed ? 0 : panelW) - COL_NUM - COL_CHECK - 6
        setNameW(Math.max(MIN_NAME_W, Math.min(maxNameW, nameDrag.startW + delta)))
      }

      if (depDrag) {
        const dx = svgX - depDrag.startX
        const deltaDays = Math.round(dx / colW)
        if (!depDrag.dragging && Math.abs(dx) > 3) {
          setDepDrag(prev => prev ? { ...prev, dragging: true, deltaDays } : null)
        } else if (depDrag.dragging && deltaDays !== depDrag.deltaDays) {
          setDepDrag(prev => prev ? { ...prev, deltaDays } : null)
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [drag, connect, rowDrag, displayRows.length, tasks, deps, getSvgX, colW, splitterDrag, panelCollapsed, throttledSetPreview, downstreamCache, nameDrag, depDrag])

  // ── Global mouseup ──────────────────────────────────────────────────────
  useEffect(() => {
    const onUp = async (e: MouseEvent) => {
      if (drag) {
        // 清理节流定时器
        if (throttleTimer.current) {
          clearTimeout(throttleTimer.current)
          throttleTimer.current = null
        }
        pendingPreview.current = null

        // Use pendingPreview if previewMap is stale (throttle dropped the last frame)
        const finalPreview = drag.dragging ? Object.values(previewMap) : []
        setDrag(null)
        setPreviewMap({})

        const isSummaryDrag = summarySet.has(drag.taskId)

        // 保留完整列表用于乐观UI更新（包含级联下游 + 摘要任务）
        const allUpdated = [...finalPreview]

        // dirtyList: 只标记需要服务端保存的任务（服务端自动级联 + 重算摘要）
        let dirtyList: Task[] = []

        if (finalPreview.length > 0 && isSummaryDrag) {
          // ── 摘要任务拖动提交：只提交非摘要后代 + 外部级联任务（服务端自动重算摘要日期）
          dirtyList = finalPreview.filter(t => !summarySet.has(t.id))
        } else if (finalPreview.length > 0 && !isSummaryDrag) {
          // ── 普通叶子任务拖动：只标记被拖任务为脏（服务端自动级联下游）
          const draggedTask = tasks.find(t => t.id === drag.taskId)
          if (draggedTask && draggedTask.auto_schedule !== false) {
            const dragged = finalPreview.find(t => t.id === drag.taskId)
            const incoming = deps.filter(d => d.to_task_id === drag.taskId)
            const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1

            if (depType === 3 || depType === 1) {
              const fixedEnd = draggedTask.end_date!
              const newStart = dragged?.start_date ?? draggedTask.start_date
              const newDur = newStart ? diffDays(new Date(newStart), new Date(fixedEnd)) : (draggedTask.duration ?? 0)
              dirtyList = [{
                ...draggedTask,
                start_date: newStart,
                end_date: fixedEnd,
                duration: Math.max(newDur, 1),
              }]
            } else {
              const hasIncoming = incoming.length > 0
              const fixedStart = hasIncoming ? draggedTask.start_date! : (dragged?.start_date ?? draggedTask.start_date!)
              const newEnd = dragged?.end_date ?? draggedTask.end_date
              const newDur = newEnd ? diffDays(new Date(fixedStart), new Date(newEnd)) : (draggedTask.duration ?? 0)
              dirtyList = [{
                ...draggedTask,
                start_date: fixedStart,
                end_date: newEnd,
                duration: Math.max(newDur, 1),
              }]
            }
          } else if (draggedTask) {
            const dragged = finalPreview.find(t => t.id === drag.taskId)
            dirtyList = [dragged ?? draggedTask]
          }
        }

        // ── 项目边界检查：拖动后若任务越过项目开始日期，按 project_boundary 策略处理
        const projStart = currentProject?.start_date?.split('T')[0]
        if (projStart && dirtyList.length > 0) {
          const violating = dirtyList.filter(t => {
            const s = t.start_date ? String(t.start_date).split('T')[0] : null
            const boundary = t.project_boundary ?? 'ask'
            return !!(s && s < projStart) && boundary !== 'ignore'
          })
          if (violating.length > 0) {
            const honored = violating.filter(t => (t.project_boundary ?? 'ask') === 'honor')
            const askList = violating.filter(t => (t.project_boundary ?? 'ask') === 'ask')
            let userWantsClamp = false
            if (askList.length > 0) {
              const names = askList.map(t => `「${t.name}」`).join('、')
              userWantsClamp = !window.confirm(
                `${names} 的开始日期早于项目开始日期 ${projStart}。\n\n确定 = 允许越界\n取消 = 吸附到项目开始日期`
              )
            }
            const clampIds = new Set<string>([
              ...honored.map(t => t.id),
              ...(userWantsClamp ? askList.map(t => t.id) : []),
            ])
            if (clampIds.size > 0) {
              const clamp = (t: Task): Task => {
                if (!clampIds.has(t.id)) return t
                const s = t.start_date ? String(t.start_date).split('T')[0] : null
                const e = t.end_date ? String(t.end_date).split('T')[0] : null
                if (!s || s >= projStart) return t
                const shift = diffDays(new Date(s), new Date(projStart))
                const newEnd = e ? addDays(new Date(e), shift) : null
                return {
                  ...t,
                  start_date: projStart,
                  end_date: newEnd ? newEnd.toISOString().slice(0,10) : t.end_date,
                }
              }
              dirtyList = dirtyList.map(clamp)
              for (let i = 0; i < allUpdated.length; i++) allUpdated[i] = clamp(allUpdated[i])
            }
          }
        }

        if (dirtyList.length > 0 || allUpdated.length > 0) {
      
          // 乐观更新UI：包含级联下游 + 摘要任务，界面立即反映关联变更
          dispatch(updateTasks(allUpdated.length > 0 ? allUpdated : dirtyList))
          // 只标记需要服务端保存的任务为脏（下游级联由服务端自动完成）
          dispatch(markDirty(dirtyList.map(t => t.id)))
          // 自动描述：拖动任务
          const draggedTask = tasks.find(t => t.id === drag.taskId)
          if (draggedTask) {
            const desc = drag.mode === 'move'
              ? `移动了任务「${draggedTask.name}」`
              : `调整了「${draggedTask.name}」的工期`
            dispatch(setEditDescription({ taskId: drag.taskId, description: desc }))
          }
          // 立即持久化到数据库（服务端自动级联下游）
        }
      }

      if (connect) {
        const svgX = getSvgX(e.clientX)
        const rect = svgRef.current?.getBoundingClientRect()
        const svgY = rect ? e.clientY - rect.top : 0
        const rowI = Math.floor(svgY / ROW_H)
        // 渲染时用的是 displayRows（应用了搜索/列筛选/差异筛选/排序），命中也必须查 displayRows
        const toRow = displayRows[rowI]

        if (toRow && toRow.task.id !== connect.fromTaskId) {
          const toTask = toRow.task
          // 父级任务不允许依赖
          if (toTask.start_date && !summarySet.has(toTask.id) && !summarySet.has(connect.fromTaskId)) {
            const tx = dateToX(new Date(toTask.start_date))
            const twRaw = toTask.end_date ? dateToX(new Date(toTask.end_date))-tx : colW
            const tw = Math.max(twRaw, BAR_H)  // 里程碑最小命中区域 = 钻石大小
            const hitX = toTask.is_milestone ? tx - BAR_H/2 : tx  // 钻石中心偏移
            if (svgX >= hitX && svgX <= hitX+tw) {
              const dup = deps.some(d => d.from_task_id===connect.fromTaskId && d.to_task_id===toTask.id)
              if (!dup) {
                const newDep: Dependency = {
                  id: uuid(), project_id: projectId,
                  from_task_id: connect.fromTaskId, to_task_id: toTask.id,
                  type: 2, lag: 0, active: true,
                }
                dispatch(addDependency(newDep))
                // 添加依赖时，后继任务自动切换为自动排程
                let nextTasks = tasks
                if (toTask.auto_schedule === false) {
                  const updatedTo = { ...toTask, auto_schedule: true }
                  dispatch(updateTasks([updatedTo]))
                  dispatch(markDirty([toTask.id]))
                  nextTasks = tasks.map(t => t.id === toTask.id ? updatedTo : t)
                }
                const cascaded = runFullCascade(nextTasks, [...deps, newDep])
                if (cascaded.length > 0) {
                  dispatch(updateTasks(cascaded))
                  dispatch(markDirty(cascaded.map(t => t.id)))
                }
              }
            }
          }
        }
        setConnect(null)
      }

      if (rowDrag) {
        if (rowDrag.dragging && dropIdx !== null) {
          const dIdx = displayRows.findIndex(r => r.task.id === rowDrag.taskId)
          if (dIdx !== -1 && dropIdx !== dIdx && dropIdx !== dIdx + 1) {
            const dTask = displayRows[dIdx].task
            const without = displayRows.filter((_, i) => i !== dIdx)
            const adj = dropIdx > dIdx ? dropIdx - 1 : dropIdx

            const newPid: string | null = adj < without.length
              ? without[adj].task.parent_id
              : without.length > 0 ? without[without.length - 1].task.parent_id : null

            const insertAt = without.slice(0, adj).filter(r => r.task.parent_id === newPid).length

            const siblings = tasks
              .filter(t => t.parent_id === newPid && t.id !== dTask.id)
              .sort((a, b) => a.order_index - b.order_index)

            const newGroup = [
              ...siblings.slice(0, insertAt),
              { ...dTask, parent_id: newPid },
              ...siblings.slice(insertAt),
            ]

            const updates: Array<{ id: string; parent_id: string | null; order_index: number }> = []
            newGroup.forEach((t, i) => {
              const orig = tasks.find(o => o.id === t.id)!
              if (orig.parent_id !== t.parent_id || orig.order_index !== i)
                updates.push({ id: t.id, parent_id: t.parent_id, order_index: i })
            })

            if (dTask.parent_id !== newPid) {
              tasks
                .filter(t => t.parent_id === dTask.parent_id && t.id !== dTask.id)
                .sort((a, b) => a.order_index - b.order_index)
                .forEach((t, i) => {
                  if (t.order_index !== i)
                    updates.push({ id: t.id, parent_id: t.parent_id, order_index: i })
                })
            }

            if (updates.length > 0) {
          
              dispatch(updateTasks(updates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))))
              dispatch(markDirty(updates.map(u => u.id)))
            }
          }
        }
        setRowDrag(null); setDropIdx(null)
      }

      if (splitterDrag) setSplitterDrag(null)
      if (nameDrag) setNameDrag(null)

      if (depDrag) {
        const { depId, startLag, deltaDays, dragging } = depDrag
        setDepDrag(null)
        if (dragging) depDragJustEndedRef.current = true
        if (dragging && deltaDays !== 0) {
          const newLag = startLag + deltaDays
          await handleDepLagChangeRef.current?.(depId, newLag)
        }
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [drag, connect, rowDrag, dropIdx, previewMap, displayRows, tasks, deps, dispatch, projectId, dateToX, getSvgX, colW, splitterDrag, nameDrag, depDrag])

  // ── Commit name edit ────────────────────────────────────────────────────
  const commitName = useCallback(async () => {
    if (nameCommittedRef.current) return          // prevent double commit (Enter+blur)
    nameCommittedRef.current = true
    const name = editNameRef.current.trim()       // always use latest value via ref
    if (!editId || !name) { setEditId(null); return }
    const orig = tasks.find(t=>t.id===editId)
    if (!orig) { setEditId(null); return }
    if (orig.name !== name) {
      const updated = { ...orig, name }

      dispatch(updateTasks([updated]))
      dispatch(markDirty([editId]))
      dispatch(setEditDescription({ taskId: editId, description: `重命名「${orig.name}」→「${name}」` }))
    }
    setEditId(null)
  }, [editId, tasks, dispatch])

  // ── Commit inline cell edit ─────────────────────────────────────────────
  const commitCellEdit = useCallback(async () => {
    if (!cellEdit) return
    const orig = tasks.find(t => t.id === cellEdit.taskId)
    if (!orig) { setCellEdit(null); return }

    let patch: Record<string, unknown> = {}
    if (cellEdit.field === 'assignee') {
      patch = { assignee: cellEdit.value.trim() || null }
    } else if (cellEdit.field === 'duration') {
      const dur = parseFloat(cellEdit.value)
      if (!isNaN(dur) && dur > 0) {
        const incoming = deps.filter(d => d.to_task_id === orig.id)
        const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1
        if (orig.auto_schedule !== false && (depType === 3 || depType === 1) && orig.end_date) {
          // FF/SF: 结束日期固定，工期改变时调整开始日期
          const newStart = fmtDate(addDays(new Date(orig.end_date), -Math.round(dur)))
          patch = { duration: Math.round(dur), start_date: newStart }
        } else if (orig.start_date) {
          // FS/SS/空/手动: 开始日期固定，工期改变时调整结束日期
          const newEnd = fmtDate(addDays(new Date(orig.start_date), Math.round(dur)))
          patch = { duration: Math.round(dur), end_date: newEnd }
        }
      }
    } else if (cellEdit.field === 'start_date') {
      if (orig.auto_schedule !== false) {
        // FF/SF: 允许编辑开始日期；FS/SS/空: 不允许
        const incoming = deps.filter(d => d.to_task_id === orig.id)
        const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1
        if (depType !== 3 && depType !== 1) { setCellEdit(null); return }
      }
      if (cellEdit.value) {
        const clampedStart = cellEdit.value
        const newDur = orig.end_date
          ? diffDays(new Date(clampedStart), new Date(orig.end_date))
          : orig.duration
        patch = { start_date: clampedStart, duration: (newDur != null && newDur > 0) ? newDur : orig.duration }
      }
    } else if (cellEdit.field === 'end_date') {
      if (cellEdit.value) {
        const newDur = orig.start_date
          ? diffDays(new Date(orig.start_date), new Date(cellEdit.value))
          : orig.duration
        patch = { end_date: cellEdit.value, duration: (newDur != null && newDur > 0) ? newDur : orig.duration }
      }
    }

    if (Object.keys(patch).length === 0) { setCellEdit(null); return }
    const updated = { ...orig, ...patch } as typeof orig


    // 客户端即时级联下游依赖任务
    const cascaded = cascadeLocal(updated, tasks, deps)
    dispatch(updateTasks([updated, ...cascaded]))
    dispatch(markDirty([orig.id, ...cascaded.map(t => t.id)]))
    // 自动描述：单元格编辑
    const fieldLabels: Record<string, string> = { assignee: '责任人', duration: '工期', start_date: '开始日期', end_date: '结束日期' }
    dispatch(setEditDescription({ taskId: orig.id, description: `修改了「${orig.name}」的${fieldLabels[cellEdit.field] ?? cellEdit.field}` }))
    setCellEdit(null)
  }, [cellEdit, tasks, deps, dispatch])

  // ── 通用字段修改（限制类型/日期/状态等） ─────────────────────────
  const handleTaskFieldChange = useCallback((taskId: string, patch: Partial<Task>) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return

    const updated = { ...t, ...patch }
    dispatch(updateTasks([updated]))
    dispatch(markDirty([taskId]))
    const fields = Object.keys(patch)
    const fieldLabels: Record<string, string> = { constraint_type: '限制类型', constraint_date: '限制日期', status: '状态', deadline: '截止日期' }
    const label = fields.map(f => fieldLabels[f] ?? f).join('、')
    dispatch(setEditDescription({ taskId, description: `修改了「${t.name}」的${label}` }))
  }, [tasks, dispatch])

  // ── 自动排程开关 ────────────────────────────────────────────────────────
  const handleAutoScheduleChange = useCallback(async (taskId: string, autoSchedule: boolean) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return

    const updated = { ...t, auto_schedule: autoSchedule }
    dispatch(updateTasks([updated]))
    dispatch(markDirty([taskId]))
    dispatch(setEditDescription({ taskId, description: `「${t.name}」切换为${autoSchedule ? '自动' : '手动'}排程` }))
  }, [tasks, dispatch])

  // ── 本地依赖变更后重算级联 + 摘要 ──────────────────────────────────────
  const recascade = useCallback((nextDeps: Dependency[], nextTasks?: Task[]) => {
    const cascaded = runFullCascade(nextTasks ?? tasks, nextDeps)
    if (cascaded.length > 0) {
      dispatch(updateTasks(cascaded))
      dispatch(markDirty(cascaded.map(t => t.id)))
    }
  }, [dispatch, tasks])

  // ── Change dependency lag ───────────────────────────────────────────────
  const handleDepLagChange = useCallback(async (depId: string, newLag: number) => {
    dispatch(updateDependency({ id: depId, lag: newLag }))
    const nextDeps = deps.map(d => d.id === depId ? { ...d, lag: newLag } : d)
    recascade(nextDeps)
  }, [dispatch, deps, recascade])
  // 同步 ref，供全局 mouseup 使用
  handleDepLagChangeRef.current = handleDepLagChange

  // ── 开始拖拽依赖线 (调整 lag) ─────────────────────────────────────────
  const onDepLineMouseDown = useCallback((e: React.MouseEvent, dep: Dependency, midX: number, midY: number) => {
    if (readOnly) return
    // 仅响应左键：避免右键/中键被 preventDefault 吞掉 contextmenu
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setDepDrag({
      depId: dep.id,
      startX: getSvgX(e.clientX),
      startLag: dep.lag ?? 0,
      deltaDays: 0,
      labelX: midX,
      labelY: midY,
      dragging: false,
    })
  }, [readOnly, getSvgX])

  // ── Change dependency type ──────────────────────────────────────────────
  const handleDepTypeChange = useCallback(async (depId: string, newType: number) => {
    dispatch(updateDependency({ id: depId, type: newType }))
    const nextDeps = deps.map(d => d.id === depId ? { ...d, type: newType } : d)
    recascade(nextDeps)
  }, [dispatch, deps, recascade])

  // ── 切换任务调度模式：空/手动/依赖类型 ─────────────────────────────────
  const handleScheduleModeChange = useCallback(async (taskId: string, value: string) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return

    if (value === 'empty') {
      // 空：删除所有入依赖，auto_schedule=true，开始日期设为项目最早任务开始日期
      const incoming = deps.filter(d => d.to_task_id === taskId)
      for (const dep of incoming) dispatch(removeDependency(dep.id))
      const remainDeps = deps.filter(d => !incoming.some(x => x.id === d.id))
      const dur = t.duration ?? 0
      const emptyStart = projectStartDate
      const newEnd = fmtDate(addDays(new Date(emptyStart), dur))
      const updatedEmpty = { ...t, auto_schedule: true, start_date: emptyStart, end_date: newEnd, duration: dur }
      dispatch(updateTasks([updatedEmpty]))
      dispatch(markDirty([taskId]))
      dispatch(setEditDescription({ taskId, description: `「${t.name}」排程模式改为无约束` }))
      recascade(remainDeps, tasks.map(x => x.id === taskId ? updatedEmpty : x))
    } else if (value === 'manual') {
      // 手动：删除所有入依赖，auto_schedule=false
      const incoming = deps.filter(d => d.to_task_id === taskId)
      for (const dep of incoming) dispatch(removeDependency(dep.id))
      const remainDeps = deps.filter(d => !incoming.some(x => x.id === d.id))
      const updatedManual = { ...t, auto_schedule: false }
      dispatch(updateTasks([updatedManual]))
      dispatch(markDirty([taskId]))
      dispatch(setEditDescription({ taskId, description: `「${t.name}」排程模式改为手动` }))
      recascade(remainDeps, tasks.map(x => x.id === taskId ? updatedManual : x))
    }
  }, [tasks, deps, dispatch, projectStartDate, recascade])

  // ── Toggle predecessor via popup（本地操作）────────────────
  const togglePredecessor = useCallback(async (fromTaskId: string, toTaskId: string) => {
    const existing = deps.find(d => d.from_task_id === fromTaskId && d.to_task_id === toTaskId)
    if (existing) {
      dispatch(removeDependency(existing.id))
      setPredPopup(null)
      const remainDeps = deps.filter(d => d.id !== existing.id)
      recascade(remainDeps)
      return
    }

    const newDep: Dependency = {
      id: uuid(), project_id: projectId,
      from_task_id: fromTaskId, to_task_id: toTaskId,
      type: 2, lag: 0, active: true,
    }
    dispatch(addDependency(newDep))
    let nextTasks = tasks
    const toTask_ = tasks.find(x => x.id === toTaskId)
    if (toTask_ && toTask_.auto_schedule === false) {
      const updatedTo = { ...toTask_, auto_schedule: true }
      dispatch(updateTasks([updatedTo]))
      dispatch(markDirty([toTaskId]))
      nextTasks = tasks.map(t => t.id === toTaskId ? updatedTo : t)
    }
    setPredPopup(null)
    recascade([...deps, newDep], nextTasks)
  }, [deps, tasks, dispatch, projectId, recascade])

  // ── Delete selected dependency ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDep && document.activeElement?.tagName !== 'INPUT') {
        dispatch(removeDependency(selectedDep))
        const remainDeps = deps.filter(d => d.id !== selectedDep)
        recascade(remainDeps)
        setSelectedDep(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDep, deps, dispatch, recascade])

  // ── Context menu: add task helper（本地新建，保存版本时入库）────────────
  const addTask = useCallback((
    name: string,
    parent_id: string | null,
    order_index: number,
    extra: { is_milestone?: boolean; start_date?: string | null; end_date?: string | null; auto_schedule?: boolean } = {}
  ): Task | null => {
    const startDate = extra.start_date !== undefined ? extra.start_date : defaultStart
    const endDate = extra.end_date !== undefined
      ? extra.end_date
      : startDate
        ? fmtDate(addDays(new Date(startDate), extra.is_milestone ? 0 : 1))
        : null
    const duration = extra.is_milestone ? 0 : 1

    const siblings = tasks.filter(t => t.parent_id === parent_id && t.order_index >= order_index)
    if (siblings.length > 0) {
      const shifted = siblings.map(t => ({ ...t, order_index: t.order_index + 1 }))
      dispatch(updateTasks(shifted))
      dispatch(markDirty(shifted.map(t => t.id)))
    }
    // 客户端生成 id + task_code
    const maxCode = tasks.reduce((m, t) => {
      const n = parseInt(t.task_code, 10)
      return !isNaN(n) && n > m ? n : m
    }, 0)
    const newTask: Task = {
      id: uuid(),
      project_id: projectId,
      task_code: String(maxCode + 1),
      name,
      parent_id,
      order_index,
      assignee: null,
      start_date: startDate,
      end_date: endDate,
      duration,
      duration_unit: 'day',
      percent_done: 0,
      is_milestone: extra.is_milestone ?? false,
      note: null,
      auto_schedule: extra.auto_schedule !== undefined ? extra.auto_schedule : true,
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as Task
    dispatch(addTasks([newTask]))
    dispatch(markDirty([newTask.id]))
    return newTask
  }, [tasks, dispatch, projectId, defaultStart])

  // ── Context menu: action handlers ────────────────────────────────────────
  const handleCtxDeleteTask = useCallback((taskId: string) => {
    setCtxMenu(null)
    // 同时移除关联依赖（本地）
    const relatedDeps = deps.filter(d => d.from_task_id === taskId || d.to_task_id === taskId)
    for (const d of relatedDeps) dispatch(removeDependency(d.id))
    dispatch(deleteTasks([taskId]))
    const remainDeps = deps.filter(d => !relatedDeps.some(x => x.id === d.id))
    const remainTasks = tasks.filter(t => t.id !== taskId)
    recascade(remainDeps, remainTasks)
  }, [dispatch, tasks, deps, recascade])

  const handleCtxAddAbove = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    addTask('New Task', t.parent_id, t.order_index, { start_date: startDate, end_date: endDate, auto_schedule: false })
  }, [tasks, addTask, defaultStart])

  const handleCtxAddBelow = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    addTask('New Task', t.parent_id, t.order_index + 1, { start_date: startDate, end_date: endDate, auto_schedule: false })
  }, [tasks, addTask, defaultStart])

  const handleCtxAddMilestone = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const nt = addTask('New Milestone', t.parent_id, t.order_index + 1, { is_milestone: true })
    if (nt) setEditModalTaskId(nt.id)
  }, [tasks, addTask])

  const handleCtxAddSubtask = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const childCount = tasks.filter(x => x.parent_id === taskId).length
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    addTask('New Sub-task', taskId, childCount, { start_date: startDate, end_date: endDate, auto_schedule: false })
    setExpanded(prev => ({ ...prev, [taskId]: true }))
  }, [tasks, addTask, defaultStart])

  const handleCtxAddSuccessor = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const newTask = addTask('New Task', t.parent_id, t.order_index + 1)
    if (!newTask) return
    const newDep: Dependency = {
      id: uuid(), project_id: projectId,
      from_task_id: taskId, to_task_id: newTask.id,
      type: 2, lag: 0, active: true,
    }
    dispatch(addDependency(newDep))
    recascade([...deps, newDep], [...tasks, newTask])
    setEditModalTaskId(newTask.id)
  }, [tasks, deps, addTask, dispatch, projectId, recascade])

  const handleCtxAddPredecessor = useCallback((taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const newTask = addTask('New Task', t.parent_id, t.order_index)
    if (!newTask) return
    const newDep: Dependency = {
      id: uuid(), project_id: projectId,
      from_task_id: newTask.id, to_task_id: taskId,
      type: 2, lag: 0, active: true,
    }
    dispatch(addDependency(newDep))
    recascade([...deps, newDep], [...tasks, newTask])
    setEditModalTaskId(newTask.id)
  }, [tasks, deps, addTask, dispatch, projectId, recascade])

  const handleCtxDeleteDep = useCallback((depId: string) => {
    setCtxMenu(null)
    dispatch(removeDependency(depId))
    const remainDeps = deps.filter(d => d.id !== depId)
    recascade(remainDeps)
  }, [dispatch, deps, recascade])

  const handleCtxEdit = useCallback((taskId: string) => {
    setCtxMenu(null)
    setEditModalTaskId(taskId)
  }, [])

  const handleCtxCopy = useCallback((taskId: string) => {
    setCtxMenu(null)
    dispatch(copyTasks([taskId]))
  }, [dispatch])

  const handleCtxCut = useCallback((taskId: string) => {
    setCtxMenu(null)
    dispatch(copyTasks([taskId]))
    const relatedDeps = deps.filter(d => d.from_task_id === taskId || d.to_task_id === taskId)
    for (const d of relatedDeps) dispatch(removeDependency(d.id))
    dispatch(deleteTasks([taskId]))
    const remainDeps = deps.filter(d => !relatedDeps.some(x => x.id === d.id))
    const remainTasks = tasks.filter(t => t.id !== taskId)
    recascade(remainDeps, remainTasks)
  }, [dispatch, tasks, deps, recascade])

  const handleCtxPaste = useCallback(() => {
    setCtxMenu(null)
    if (!clipboard.length) return
    const maxCode = tasks.reduce((m, t) => {
      const n = parseInt(t.task_code, 10)
      return !isNaN(n) && n > m ? n : m
    }, 0)
    const pasted: Task[] = clipboard.map((t, i) => ({
      ...t,
      id: uuid(),
      task_code: String(maxCode + 1 + i),
      name: `${t.name} (副本)`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as Task))
    dispatch(addTasks(pasted))
    dispatch(markDirty(pasted.map(t => t.id)))
  }, [dispatch, clipboard, tasks])

  const handleCtxConvertMilestone = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return

    const toMilestone = !t.is_milestone
    const patch: Partial<Task> = { is_milestone: toMilestone }
    if (toMilestone) {
      // 转为里程碑：工期=0, end_date=start_date, 完成度=100%
      patch.duration = 0
      patch.percent_done = 100
      if (t.start_date) patch.end_date = t.start_date
    } else {
      // 转为普通任务：工期=1, end_date=start+1, 完成度保留
      patch.duration = 1
      if (t.start_date) patch.end_date = fmtDate(addDays(new Date(t.start_date), 1))
    }
    const updated = { ...t, ...patch }
    dispatch(updateTasks([updated]))
    dispatch(markDirty([taskId]))
  }, [dispatch, tasks])

  const handleCtxIndent = useCallback((taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const anchor = tasks
      .filter(t => t.parent_id === task.parent_id && t.order_index < task.order_index)
      .sort((a, b) => b.order_index - a.order_index)[0]
    if (!anchor) return

    // anchor 变父级：取消 anchor 的所有依赖
    const depsToRemove = deps.filter(d => d.from_task_id === anchor.id || d.to_task_id === anchor.id)
    for (const dep of depsToRemove) dispatch(removeDependency(dep.id))
    const existingChildren = tasks.filter(t => t.parent_id === anchor.id)
    const newOrder = existingChildren.length > 0 ? Math.max(...existingChildren.map(t => t.order_index)) + 1 : 0
    const movedTask = { ...task, parent_id: anchor.id, order_index: newOrder }
    dispatch(updateTasks([movedTask]))
    dispatch(markDirty([taskId]))
    const remainDeps = deps.filter(d => !depsToRemove.some(x => x.id === d.id))
    const nextTasks = tasks.map(t => t.id === taskId ? movedTask : t)
    recascade(remainDeps, nextTasks)
  }, [dispatch, tasks, deps, recascade])

  const handleCtxOutdent = useCallback((taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task || !task.parent_id) return
    const parent = tasks.find(t => t.id === task.parent_id)!

    // 升级时删除被升级任务与旧父任务之间的依赖关系
    const depsToRemove = deps.filter(d =>
      (d.from_task_id === taskId && d.to_task_id === parent.id) ||
      (d.from_task_id === parent.id && d.to_task_id === taskId)
    )
    for (const dep of depsToRemove) dispatch(removeDependency(dep.id))

    const siblingsAfterParent = tasks
      .filter(t => t.parent_id === parent.parent_id && t.order_index > parent.order_index)
    const shifted = siblingsAfterParent.map(s => ({ ...s, order_index: s.order_index + 1 }))
    const updated = { ...task, parent_id: parent.parent_id, order_index: parent.order_index + 1 }
    const allUpdates = [updated, ...shifted]
    dispatch(updateTasks(allUpdates))
    dispatch(markDirty([taskId, ...shifted.map(s => s.id)]))
    const remainDeps = deps.filter(d => !depsToRemove.some(x => x.id === d.id))
    const nextTasks = tasks.map(t => {
      const u = allUpdates.find(x => x.id === t.id)
      return u ?? t
    })
    recascade(remainDeps, nextTasks)
  }, [dispatch, tasks, deps, recascade])

  const handleCtxAddDep = useCallback((fromId: string, toId: string) => {
    setCtxMenu(null)
    const already = deps.find(d => d.from_task_id === fromId && d.to_task_id === toId)
    if (already) return
    const newDep: Dependency = {
      id: uuid(), project_id: projectId,
      from_task_id: fromId, to_task_id: toId,
      type: 2, lag: 0, active: true,
    }
    dispatch(addDependency(newDep))
    let nextTasks = tasks
    const toTask__ = tasks.find(x => x.id === toId)
    if (toTask__ && toTask__.auto_schedule === false) {
      const updatedTo = { ...toTask__, auto_schedule: true }
      dispatch(updateTasks([updatedTo]))
      dispatch(markDirty([toId]))
      nextTasks = tasks.map(t => t.id === toId ? updatedTo : t)
    }
    recascade([...deps, newDep], nextTasks)
  }, [dispatch, projectId, deps, tasks, recascade])

  const handleCtxRemoveAllDeps = useCallback((taskId: string) => {
    setCtxMenu(null)
    const taskDeps = deps.filter(d => d.from_task_id === taskId || d.to_task_id === taskId)
    for (const d of taskDeps) dispatch(removeDependency(d.id))
    const remainDeps = deps.filter(d => !taskDeps.some(x => x.id === d.id))
    recascade(remainDeps)
  }, [dispatch, deps, recascade])

  const handleEnableAutoSchedule = useCallback(() => {
    setCtxMenu(null)
    if (!confirm('将为所有有依赖关系的任务启用自动排程，确认？')) return
    const idsWithDeps = new Set<string>()
    for (const d of deps) idsWithDeps.add(d.to_task_id)
    const updates = tasks
      .filter(t => idsWithDeps.has(t.id) && t.auto_schedule === false)
      .map(t => ({ ...t, auto_schedule: true }))
    if (updates.length === 0) { alert('没有需要启用的任务'); return }
    dispatch(updateTasks(updates))
    dispatch(markDirty(updates.map(t => t.id)))
    const nextTasks = tasks.map(t => updates.find(u => u.id === t.id) ?? t)
    recascade(deps, nextTasks)
    alert(`已启用 ${updates.length} 个任务的自动排程`)
  }, [tasks, deps, dispatch, recascade])

  const handleFixProjectDates = useCallback(() => {
    setCtxMenu(null)
    if (!confirm('将根据依赖关系重新计算所有任务日期，确认？')) return
    const cascaded = runFullCascade(tasks, deps)
    if (cascaded.length > 0) {
      dispatch(updateTasks(cascaded))
      dispatch(markDirty(cascaded.map(t => t.id)))
    }
    alert(`已重算 ${cascaded.length} 个任务的日期`)
  }, [tasks, deps, dispatch])

  const toggle = useCallback((id: string) => {
    setExpanded(prev=>({ ...prev, [id]:!(prev[id]??true) }))
  }, [])

  const rightW = rightRef.current?.clientWidth ?? 1200
  const totalW = Math.max(totalDays * colW, rightW + 100)
  const totalH = displayRows.length * ROW_H

  // ── Dynamic panel sizing ─────────────────────────────────────────────────
  const effectivePanelW = panelCollapsed ? 0 : panelW

  // 列宽覆盖（用户拖动调整后持久化到 localStorage）
  const colWidthStorageKey = `gantt-col-widths-${projectId}`
  const [colWidthOverrides, setColWidthOverrides] = useState<Partial<Record<OptionalCol, number>>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const saved = localStorage.getItem(`gantt-col-widths-${projectId}`)
      if (saved) return JSON.parse(saved) as Partial<Record<OptionalCol, number>>
    } catch { /* ignore */ }
    return {}
  })
  const [colResizeDrag, setColResizeDrag] = useState<{ col: OptionalCol; startX: number; startW: number } | null>(null)
  useEffect(() => {
    if (!colResizeDrag) return
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - colResizeDrag.startX
      const newW = Math.max(24, colResizeDrag.startW + dx)
      setColWidthOverrides(p => ({ ...p, [colResizeDrag.col]: newW }))
    }
    const onUp = () => {
      setColResizeDrag(null)
      setColWidthOverrides(p => {
        try { localStorage.setItem(colWidthStorageKey, JSON.stringify(p)) } catch { /* ignore */ }
        return p
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [colResizeDrag, colWidthStorageKey])

  // 右折叠时：按内容宽度自动展开左面板列（折叠恢复后回到用户设置）
  const autoFitColWidths = useMemo(() => {
    if (!rightCollapsed) return null
    const isCJK = (c: string) => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(c)
    const measure = (s: string) => {
      let w = 0
      for (const c of s) w += isCJK(c) ? 13 : 7
      return w
    }
    const CELL_PAD = 16
    const HDR_PAD = 40 // 表头含排序/筛选图标
    const headerW = (label: string) => measure(label) + HDR_PAD
    const contentW = (fn: (t: Task) => string) => {
      let m = 0
      for (const t of tasks) m = Math.max(m, measure(fn(t)))
      return m + CELL_PAD
    }
    return {
      name:       Math.max(MIN_NAME_W, headerW('任务名称'), contentW(t => t.name ?? '') + 32),
      assignee:   Math.max(headerW('责任人'),   contentW(t => t.assignee ?? '')),
      pct:        Math.max(headerW('完成'),     contentW(t => `${Math.round(t.percent_done ?? 0)}%`)),
      duration:   Math.max(headerW('持续时间'), contentW(t => t.duration != null ? `${t.duration}天` : '')),
      start:      Math.max(headerW('开始时间'), contentW(t => (t.start_date ?? '').split('T')[0])),
      end:        Math.max(headerW('完成时间'), contentW(t => (t.end_date ?? '').split('T')[0])),
      pred:       headerW('前导'),
      succ:       headerW('后继'),
      lag:        headerW('延迟'),
      ctype:      Math.max(headerW('限制类型'), contentW(t => t.constraint_type ?? 'asap')),
      cdate:      Math.max(headerW('限制日期'), contentW(t => (t.constraint_date ?? '').split('T')[0])),
      ddate:      Math.max(headerW('截止日期'), contentW(t => (t.deadline ?? '').split('T')[0])),
      status:     Math.max(headerW('状态'),     contentW(t => t.status ?? '')),
      inactive:   Math.max(headerW('无效'),     contentW(t => t.inactive ? '是' : '否')),
    } as Record<OptionalCol | 'name', number>
  }, [rightCollapsed, tasks])

  // Right columns: only include visible optional columns
  const RIGHT_COL_BASES = useMemo(() =>
    OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).map(c =>
      autoFitColWidths ? autoFitColWidths[c.key] : (colWidthOverrides[c.key] ?? c.width)
    ),
    [visibleCols, colWidthOverrides, autoFitColWidths])
  const RIGHT_COLS_TOTAL = RIGHT_COL_BASES.reduce((a, b) => a + b, 0)
  const rightColWidths = RIGHT_COL_BASES
  const nameColW = autoFitColWidths ? autoFitColWidths.name : nameW
  const leftNaturalW = COL_NUM + COL_CHECK + nameColW + RIGHT_COLS_TOTAL
  const leftInnerW = Math.max(leftNaturalW, effectivePanelW)
  // Map visible column keys to their computed widths
  const visibleColWidths = useMemo(() => {
    const map: Record<OptionalCol, number> = { assignee: 0, pct: 0, duration: 0, start: 0, end: 0, pred: 0, succ: 0, lag: 0, ctype: 0, cdate: 0, ddate: 0, status: 0, inactive: 0 }
    const visibleKeys = OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).map(c => c.key)
    visibleKeys.forEach((k, i) => { map[k] = rightColWidths[i] ?? 0 })
    return map
  }, [visibleCols, rightColWidths])
  const colAssignW = visibleColWidths.assignee
  const colPctW    = visibleColWidths.pct
  const colDurW    = visibleColWidths.duration
  const colStartW  = visibleColWidths.start
  const colEndW    = visibleColWidths.end
  const colPredW   = visibleColWidths.pred
  const colSuccW   = visibleColWidths.succ
  const colLagW    = visibleColWidths.lag
  const colCtypeW  = visibleColWidths.ctype
  const colCdateW  = visibleColWidths.cdate
  const colDDateW  = visibleColWidths.ddate
  const colStatusW = visibleColWidths.status
  const colInactiveW = visibleColWidths.inactive

  // ── Distinct values per filterable column (for filter dropdowns) ─────────
  const distinctValues = useMemo(() => {
    const fmt = (s: string | null | undefined) => (s ?? '').split('T')[0]
    const pred = (t: Task) => deps.filter(d => d.to_task_id === t.id).length > 0 ? '有' : '无'
    const succ = (t: Task) => deps.filter(d => d.from_task_id === t.id).length > 0 ? '有' : '无'
    const sdForStatus = statusDate ? new Date(statusDate) : null
    const byIdForStatus = new Map(tasksWithSnapshotBaseline.map(x => [x.id, x] as const))
    const statusCtx = { allTasks: tasksWithSnapshotBaseline, deps, prevTaskIds: prevSnapshotTaskIds }
    const statusValue = (t: Task): string => {
      const st = computeTaskStatus(byIdForStatus.get(t.id) ?? t, sdForStatus, statusCtx).status
      const isNewTask = prevSnapshotTaskIds.size > 0 && !prevSnapshotTaskIds.has(t.id)
      if (isNewTask && (st === 'notstarted' || st === 'started' || st === 'completed')) return `new:${st}`
      return st
    }
    const builder: Record<OptionalCol, (t: Task) => string> = {
      assignee:   t => t.assignee ?? '',
      pct:        t => String(t.percent_done ?? 0),
      duration:   t => t.duration != null ? String(t.duration) : '',
      start:      t => fmt(t.start_date),
      end:        t => fmt(t.end_date),
      pred,
      succ,
      lag:        t => {
        const d = deps.find(x => x.to_task_id === t.id)
        return d ? String(d.lag ?? 0) : ''
      },
      ctype:      t => t.constraint_type ?? 'asap',
      cdate:      t => fmt(t.constraint_date),
      ddate:      t => fmt(t.deadline),
      status:     statusValue,
      inactive:   t => t.inactive ? '是' : '否',
    }
    const out = {} as Record<OptionalCol, string[]>
    ;(Object.keys(builder) as OptionalCol[]).forEach(k => {
      const s = new Set<string>()
      tasks.forEach(t => s.add(builder[k](t)))
      out[k] = [...s].sort()
    })
    return out
  }, [tasks, deps, statusDate, tasksWithSnapshotBaseline, prevSnapshotTaskIds])

  const colDisplayLabel = useCallback((k: OptionalCol, v: string): string => {
    if (v === '') return '（空）'
    if (k === 'ctype') return CONSTRAINT_TYPES.find(c => c.value === v)?.label ?? v
    if (k === 'status') {
      if (v.startsWith('new:')) {
        const base = v.slice(4)
        return `新任务，${STATUS_META[base as keyof typeof STATUS_META]?.label ?? base}`
      }
      return STATUS_META[v as keyof typeof STATUS_META]?.label ?? v
    }
    return v
  }, [])

  const renderColHeader = (colKey: OptionalCol, label: string, width: number) => {
    if (width <= 0) return null
    const sortActive = sortCol === colKey
    const filterSet  = colFilters[colKey]
    const hasFilter  = !!filterSet && filterSet.size > 0
    const values     = distinctValues[colKey] ?? []
    const isDragging = draggedCol === colKey
    const isDragOver = dragOverCol === colKey && draggedCol !== null && draggedCol !== colKey
    return (
      <div style={{ width, position: 'relative', order: colOrderOf(colKey),
                    opacity: isDragging ? 0.4 : 1,
                    boxShadow: isDragOver ? 'inset 3px 0 0 #3b82f6' : undefined }}
           draggable={!readOnly}
           onDragStart={e => {
             setDraggedCol(colKey)
             e.dataTransfer.effectAllowed = 'move'
             try { e.dataTransfer.setData('text/plain', colKey) } catch { /* ignore */ }
           }}
           onDragEnd={() => { setDraggedCol(null); setDragOverCol(null) }}
           onDragEnter={e => { if (draggedCol && draggedCol !== colKey) { e.preventDefault(); setDragOverCol(colKey) } }}
           onDragOver={e => { if (draggedCol && draggedCol !== colKey) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
           onDragLeave={() => { if (dragOverCol === colKey) setDragOverCol(null) }}
           onDrop={e => {
             e.preventDefault()
             if (draggedCol) handleColReorder(draggedCol, colKey)
             setDraggedCol(null); setDragOverCol(null)
           }}
           className="h-full flex items-end pb-1 px-1 border-r border-gray-200 flex-none overflow-visible select-none cursor-grab active:cursor-grabbing">
        {width >= 24 && (
          <div className="flex items-center w-full gap-0.5">
            <span className="text-[11px] truncate flex-1 cursor-pointer"
                  onClick={e => { e.stopPropagation(); toggleSort(colKey) }}
                  title="点击排序，拖动表头可调整列顺序">{label}</span>
            <button type="button" className="flex-none p-0.5 hover:bg-gray-200 rounded cursor-pointer"
                    onClick={e => { e.stopPropagation(); toggleSort(colKey) }}
                    title="排序">
              <svg width="8" height="10" viewBox="0 0 8 10">
                <path d="M4 0 L7 4 L1 4 Z" fill={sortActive && sortDir === 'asc' ? '#2563eb' : '#cbd5e1'} />
                <path d="M4 10 L7 6 L1 6 Z" fill={sortActive && sortDir === 'desc' ? '#2563eb' : '#cbd5e1'} />
              </svg>
            </button>
            <button type="button" className="flex-none p-0.5 hover:bg-gray-200 rounded cursor-pointer"
                    onClick={e => { e.stopPropagation(); setColDropdown(colDropdown === colKey ? null : colKey) }}
                    title="筛选">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M0.5 1 H9.5 L6 5 V9 L4 9 V5 Z" fill={hasFilter ? '#f97316' : '#94a3b8'} />
              </svg>
            </button>
          </div>
        )}
        {/* 列宽拖动手柄 */}
        <div
          className="group/colresize"
          style={{ position: 'absolute', right: -3, top: 0, width: 7, height: '100%', cursor: 'col-resize', zIndex: 3 }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setColResizeDrag({ col: colKey, startX: e.clientX, startW: width }) }}
          onClick={e => e.stopPropagation()}
        >
          <div className="absolute left-1/2 top-1/4 -translate-x-1/2 w-[2px] h-1/2 rounded bg-transparent group-hover/colresize:bg-blue-400 transition-colors" />
        </div>
        {colDropdown === colKey && (
          <div ref={colDropdownRef}
               className="absolute top-full right-0 z-50 bg-white border border-gray-300 rounded shadow-lg py-1 min-w-[140px] max-h-[300px] overflow-y-auto"
               onClick={e => e.stopPropagation()}>
            <div className="px-2 py-1 text-[11px] text-gray-500 border-b border-gray-100 flex items-center justify-between">
              <span>筛选</span>
              {hasFilter && (
                <button className="text-[10px] text-blue-600 hover:underline"
                        onClick={() => { setColFilters(p => { const n = { ...p }; delete n[colKey]; return n }) }}>清除</button>
              )}
            </div>
            <div className="px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 flex items-center gap-1"
                 onClick={() => {
                   setColFilters(p => {
                     const all = new Set(values)
                     return { ...p, [colKey]: (filterSet && filterSet.size === values.length) ? new Set<string>() : all }
                   })
                 }}>
              <input type="checkbox" readOnly className="pointer-events-none"
                     checked={!!filterSet && filterSet.size === values.length} />
              <span>全选</span>
            </div>
            {values.map(v => {
              const checked = !filterSet || filterSet.has(v)
              return (
                <div key={v}
                     className="px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 flex items-center gap-1 truncate"
                     onClick={() => {
                       setColFilters(p => {
                         const cur = p[colKey] ? new Set(p[colKey]) : new Set(values)
                         if (cur.has(v)) cur.delete(v); else cur.add(v)
                         return { ...p, [colKey]: cur }
                       })
                     }}>
                  <input type="checkbox" readOnly className="pointer-events-none" checked={checked} />
                  <span className="truncate">{colDisplayLabel(colKey, v)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden select-none"
         style={{ fontFamily:'system-ui,sans-serif', fontSize:13,
                  cursor: (splitterDrag || nameDrag) ? 'col-resize' : undefined }}>

      {/* ── Left panel ───────────────────────────────────────────────── */}
      <div className={`${rightCollapsed ? 'flex-1' : 'flex-none'} bg-white`}
           style={{ width: rightCollapsed ? undefined : effectivePanelW, minWidth: 0, overflowX: 'scroll', overflowY: 'hidden', transition: splitterDrag ? undefined : 'width 0.15s ease' }}>
       <div className="flex flex-col h-full" style={{ width: leftInnerW }}>
        {/* Column headers */}
        <div className="flex-none flex items-end border-b border-gray-300 bg-gray-50
                        font-semibold text-gray-500 text-[11px]"
             style={{ height: HDR_H, minWidth: leftInnerW }}>
          {/* 任务编号 header */}
          <div style={{ width: COL_NUM }}
               className="h-full flex items-end pb-1 justify-center border-r border-gray-200 flex-none text-gray-400">
            编号
          </div>
          {/* Checkbox header */}
          <div style={{ width: COL_CHECK }}
               className="h-full flex items-center justify-center border-r border-gray-200 flex-none">
            <input type="checkbox"
                   className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                   checked={displayRows.length > 0 && displayRows.every(r => selectedIds.includes(r.task.id))}
                   onChange={e => dispatch(setSelectedIds(e.target.checked ? displayRows.map(r => r.task.id) : []))} />
          </div>
          <div style={{ width: nameColW, paddingLeft: 4, minWidth: MIN_NAME_W, position: 'relative' }}
               className="h-full flex items-end pb-1 border-r border-gray-200 flex-none">
            任务名称
            {/* Name column resize handle — wider grab zone with hover highlight */}
            <div
              className="group/resize"
              style={{ position: 'absolute', right: -3, top: 0, width: 7, height: '100%', cursor: 'col-resize', zIndex: 2 }}
              onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setNameDrag({ startX: e.clientX, startW: nameW }) }}
            >
              <div className="absolute left-1/2 top-1/4 -translate-x-1/2 w-[2px] h-1/2 rounded bg-transparent group-hover/resize:bg-blue-400 transition-colors" />
            </div>
          </div>
          {renderColHeader('assignee', '责任人', colAssignW)}
          {renderColHeader('status', '状态', colStatusW)}
          {renderColHeader('duration', '持续时间', colDurW)}
          {renderColHeader('start', '开始', colStartW)}
          {renderColHeader('end', '完成时间', colEndW)}
          {renderColHeader('pred', '前导', colPredW)}
          {renderColHeader('succ', '后继', colSuccW)}
          {renderColHeader('lag', '延迟', colLagW)}
          {renderColHeader('ctype', '限制类型', colCtypeW)}
          {renderColHeader('cdate', '限制日期', colCdateW)}
          {renderColHeader('ddate', '截止日期', colDDateW)}
          {renderColHeader('pct', '完成', colPctW)}
          {renderColHeader('inactive', '无效', colInactiveW)}
        </div>

        {/* Rows */}
        <div ref={leftRef} className="overflow-y-scroll flex-1 scrollbar-hide"
             onScroll={onLeftBodyScroll}
             style={{ cursor: rowDrag?.dragging ? 'grabbing' : undefined }}>
          {displayRows.map((row, i) => {
            const t = row.task
            const sel = selectedIds.includes(t.id)
            const isEditing = editId === t.id
            const isDraggingThis = rowDrag?.dragging && rowDrag.taskId === t.id
            const incomingDeps = deps.filter(d => d.to_task_id === t.id)
            const predNums = incomingDeps
              .map(d => flatRowIdx[d.from_task_id])
              .filter(Boolean)
              .join(',')
            const outgoingDeps = deps.filter(d => d.from_task_id === t.id)
            const succNums = outgoingDeps
              .map(d => flatRowIdx[d.to_task_id])
              .filter(Boolean)
              .join(',')
            const fmtCell = (s: string | null) =>
              s ? s.split('T')[0].slice(5) : ''  // MM-DD
            const cellRing = (col: OptionalCol | 'name') =>
              selectedCell?.taskId === t.id && selectedCell?.col === col ? 'ring-2 ring-inset ring-blue-500' : ''
            const pickCell = (col: OptionalCol | 'name') => () => setSelectedCell({ taskId: t.id, col })
            return (
              <React.Fragment key={t.id}>
                {rowDrag?.dragging && dropIdx === i && (
                  <div style={{ height: 2, background: '#3b82f6', flexShrink: 0 }} />
                )}
                <div
                  className={`flex border-b border-gray-100 cursor-pointer
                    ${sel ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  style={{ height: ROW_H, opacity: isDraggingThis ? 0.35 : 1 }}
                  onClick={e => {
                    if (rowDrag?.dragging) return
                    if (isEditing || cellEdit?.taskId === t.id) return
                    // 单击单元格不再选中整行；仅 Ctrl/Meta+click 切换行选中（用于多选操作）
                    if (e.ctrlKey || e.metaKey) {
                      dispatch(setSelectedIds(sel ? selectedIds.filter(x => x !== t.id) : [...selectedIds, t.id]))
                    }
                    // Center right panel on clicked task
                    if (!e.ctrlKey && !e.metaKey && t.start_date && t.end_date && rightRef.current) {
                      const x1 = dateToX(new Date(t.start_date))
                      const x2 = dateToX(new Date(t.end_date))
                      const barCenter = (x1 + x2) / 2
                      syncTimelineScrollLeft(Math.max(0, barCenter - rightRef.current.clientWidth / 2))
                    }
                  }}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation()
                    if (!readOnly) setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null })
                  }}
                >
                  {/* ── WBS number cell with drag handle ── */}
                  <div style={{ width: COL_NUM }}
                       className="flex items-center border-r border-gray-100 h-full flex-none flex-shrink-0 relative group/wbs">
                    {/* Drag handle */}
                    <div
                      className="flex items-center justify-center w-4 h-full cursor-grab active:cursor-grabbing opacity-0 group-hover/wbs:opacity-100 transition-opacity flex-none"
                      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onRowDragStart(e, t.id) }}
                      title="拖动排序"
                    >
                      <svg viewBox="0 0 6 10" width="6" height="10" fill="#9ca3af">
                        <circle cx="1.5" cy="1.5" r="1" /><circle cx="4.5" cy="1.5" r="1" />
                        <circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" />
                        <circle cx="1.5" cy="8.5" r="1" /><circle cx="4.5" cy="8.5" r="1" />
                      </svg>
                    </div>
                    <span className="text-[10px] font-mono text-gray-400 truncate flex-1 text-center">
                      {seqMap.get(t.id) ?? (i + 1)}
                    </span>
                  </div>

                  {/* ── Checkbox cell ─────────────────────────────── */}
                  <div style={{ width: COL_CHECK }}
                       className="flex items-center justify-center border-r border-gray-100 h-full flex-none flex-shrink-0">
                    <input type="checkbox"
                           className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                           checked={sel}
                           onChange={e => {
                             e.stopPropagation()
                             dispatch(setSelectedIds(e.target.checked
                               ? [...selectedIds, t.id]
                               : selectedIds.filter(x => x !== t.id)
                             ))
                           }}
                           onClick={e => e.stopPropagation()} />
                  </div>

                  {/* ── Name cell ─────────────────────────────────── */}
                  <div style={{ width: nameColW, minWidth: MIN_NAME_W, paddingLeft: 4 + row.level * 16 }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none overflow-hidden ${isEditing ? '' : cellRing('name')}`}
                       onClick={pickCell('name')}
                       onDoubleClick={() => { if (!readOnly) { setEditId(t.id); setEditName(t.name) } }}>
                    {row.hasChildren
                      ? <button onClick={e => { e.stopPropagation(); toggle(t.id) }}
                                className="w-5 h-5 flex-none flex items-center justify-center rounded
                                           bg-blue-50 hover:bg-blue-200 text-blue-600 hover:text-blue-800
                                           text-sm font-bold transition-colors">
                          {row.expanded ? '▾' : '▸'}
                        </button>
                      : <span className="w-5 h-5 flex-none flex items-center justify-center text-gray-300">·</span>
                    }
                    {isEditing
                      ? <input ref={nameInputRef}
                               className="flex-1 border border-blue-300 rounded px-1 text-[12px] outline-none min-w-0 focus:border-blue-400"
                               value={editName}
                               onChange={e => setEditName(e.target.value)}
                               onBlur={commitName}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitName()
                                 if (e.key === 'Escape') { nameCommittedRef.current = true; setEditId(null) }
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className={`truncate text-[12px] flex-1 min-w-0 ${row.hasChildren
                          ? 'font-bold text-gray-800' : 'text-gray-700'}`}>
                          {t.name}
                        </span>
                    }
                  </div>

                  {/* ── Assignee cell ─────────────────────────────── */}
                  {colAssignW > 0 && (
                  <div style={{ width: colAssignW, order: colOrderOf('assignee') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('assignee')}`}
                       onClick={pickCell('assignee')}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         setCellEdit({ taskId: t.id, field: 'assignee', value: t.assignee ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'assignee'
                      ? <input autoFocus
                               className="w-full border border-blue-400 rounded px-1 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="truncate text-[11px] text-gray-600 w-full">
                          {t.assignee ?? ''}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── 状态（自动计算；与"完成"换位） ───────────────── */}
                  {colStatusW > 0 && (() => {
                    const snapshotEnd = latestSnapshotEnds.get(t.id) ?? null
                    const baselineEnd = snapshotEnd
                      ?? (t.baseline_end_date ? String(t.baseline_end_date).split('T')[0] : null)
                    const taskForStatus = baselineEnd !== (t.baseline_end_date ? String(t.baseline_end_date).split('T')[0] : null)
                      ? { ...t, baseline_end_date: baselineEnd }
                      : t
                    // 所有前置任务也需要覆盖 baseline，否则 isEndExtended 无法识别上游延期
                    // prevTaskIds 用于识别"本期新增任务"作为延期根源
                    // seqMap 让归因文案里的编号与左列"编号"一致
                    const { status: st, reason: statusReason } = computeTaskStatus(
                      taskForStatus,
                      statusDate ? new Date(statusDate) : null,
                      { allTasks: tasksWithSnapshotBaseline, deps, prevTaskIds: prevSnapshotTaskIds, seqMap },
                    )
                    const meta = STATUS_META[st]
                    let deltaText = ''
                    {
                      const e = t.end_date ? String(t.end_date).split('T')[0] : null
                      if (baselineEnd && e) {
                        const days = diffDays(new Date(baselineEnd), new Date(e))
                        if (days !== 0) deltaText = ` ${days > 0 ? '+' : ''}${days}天`
                      }
                    }
                    // 本期新增（上期快照没有）且当前仍是普通状态 → 前缀"新任务，"
                    const isNewTask = prevSnapshotTaskIds.size > 0 && !prevSnapshotTaskIds.has(t.id)
                    const labelText = (isNewTask && (st === 'notstarted' || st === 'started' || st === 'completed'))
                      ? `新任务，${meta.label}`
                      : meta.label
                    const filledReason = filledReasonByCode.get(t.task_code) ?? ''
                    const tooltipParts: string[] = [`${labelText}${deltaText}`]
                    if (statusReason) tooltipParts.push(`延期原因: ${statusReason}`)
                    if (filledReason) tooltipParts.push(`填报原因: ${filledReason}`)
                    const tooltip = tooltipParts.length > 1 || statusReason || filledReason ? tooltipParts.join('\n') : ''
                    return (
                      <div style={{ width: colStatusW, order: colOrderOf('status') }}
                           className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('status')} ${filledReason ? 'cursor-pointer' : ''}`}
                           onClick={e => {
                             pickCell('status')()
                             if (filledReason) {
                               e.stopPropagation()
                               const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                               setReasonPopup({
                                 x: rect.left,
                                 y: rect.bottom + 4,
                                 reason: filledReason,
                                 taskName: t.name,
                               })
                             }
                           }}
                           title={tooltip}>
                        <span className="inline-flex items-center gap-1 text-[11px] truncate"
                              style={{ color: meta.color }}>
                          <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: meta.color }} />
                          {labelText}{deltaText}
                          {filledReason && <span className="text-orange-500 ml-0.5">*</span>}
                        </span>
                      </div>
                    )
                  })()}

                  {/* ── Duration cell ─────────────────────────────── */}
                  {colDurW > 0 && (
                  <div style={{ width: colDurW, order: colOrderOf('duration') }}
                       className={`flex items-center justify-end border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('duration')}`}
                       onClick={pickCell('duration')}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         setCellEdit({ taskId: t.id, field: 'duration', value: t.duration != null ? String(t.duration) : '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'duration'
                      ? <input autoFocus type="number" min={1}
                               className="w-full border border-blue-400 rounded px-1 text-[11px] outline-none text-right"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {t.duration != null ? t.duration : ''}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── Start date cell ───────────────────────────── */}
                  {colStartW > 0 && (
                  <div style={{ width: colStartW, order: colOrderOf('start') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('start')}`}
                       onClick={pickCell('start')}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         if (t.auto_schedule !== false) {
                           const inc = deps.filter(d => d.to_task_id === t.id)
                           const dt = inc.length > 0 ? (inc[0].type ?? 2) : -1
                           if (dt !== 3 && dt !== 1) return
                         }
                         setCellEdit({ taskId: t.id, field: 'start_date', value: t.start_date?.split('T')[0] ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'start_date'
                      ? <input autoFocus type="date"
                               className="w-full border border-blue-400 rounded px-0.5 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {fmtCell(t.start_date)}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── End date cell ────────────────────────────── */}
                  {colEndW > 0 && (
                  <div style={{ width: colEndW, order: colOrderOf('end') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('end')}`}
                       onClick={pickCell('end')}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         if (t.auto_schedule !== false) {
                           const inc = deps.filter(d => d.to_task_id === t.id)
                           const dt = inc.length > 0 ? (inc[0].type ?? 2) : -1
                           // FS/SS: 结束日期由工期推导，不可编辑；FF/SF: 结束日期可编辑
                           if (dt !== 3 && dt !== 1 && dt !== -1) return
                         }
                         setCellEdit({ taskId: t.id, field: 'end_date', value: t.end_date?.split('T')[0] ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'end_date'
                      ? <input autoFocus type="date"
                               className="w-full border border-blue-400 rounded px-0.5 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {fmtCell(t.end_date)}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── Predecessors cell (clickable popup) ───────── */}
                  {colPredW > 0 && (
                  <div style={{ width: colPredW, order: colOrderOf('pred') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden relative group ${cellRing('pred')}`}
                       onClick={e => { e.stopPropagation(); setSelectedCell({ taskId: t.id, col: 'pred' }) }}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (row.hasChildren) return
                         const rect = e.currentTarget.getBoundingClientRect()
                         setPredFilter('')
                         const popupH = 320
                         const spaceBelow = window.innerHeight - rect.bottom
                         const yPos = spaceBelow < popupH ? rect.top - popupH : rect.bottom
                         setPredPopup({ taskId: t.id, x: rect.left, y: yPos })
                       }}>
                    <span className="text-[11px] text-gray-600 truncate flex-1">{row.hasChildren ? '—' : predNums}</span>
                    {!row.hasChildren && <span className="text-[9px] text-gray-400 flex-none group-hover:text-gray-600">▾</span>}
                  </div>
                  )}

                  {/* ── Successors cell (clickable popup) ────── */}
                  {colSuccW > 0 && (
                  <div style={{ width: colSuccW, order: colOrderOf('succ') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden relative group ${cellRing('succ')}`}
                       onClick={e => { e.stopPropagation(); setSelectedCell({ taskId: t.id, col: 'succ' }) }}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (row.hasChildren) return
                         const rect = e.currentTarget.getBoundingClientRect()
                         setSuccFilter('')
                         const popupH = 320
                         const spaceBelow = window.innerHeight - rect.bottom
                         const yPos = spaceBelow < popupH ? rect.top - popupH : rect.bottom
                         setSuccPopup({ taskId: t.id, x: rect.left, y: yPos })
                       }}>
                    <span className="text-[11px] text-gray-600 truncate flex-1">{row.hasChildren ? '—' : succNums}</span>
                    {!row.hasChildren && <span className="text-[9px] text-gray-400 flex-none group-hover:text-gray-600">▾</span>}
                  </div>
                  )}

                  {/* ── 延迟 cell ── */}
                  {colLagW > 0 && (
                  <div style={{ width: colLagW, order: colOrderOf('lag') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('lag')}`}
                       onClick={e => { e.stopPropagation(); setSelectedCell({ taskId: t.id, col: 'lag' }) }}
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (row.hasChildren || incomingDeps.length === 0) return
                         setActiveEditor({ taskId: t.id, col: 'lag' })
                       }}>
                    {row.hasChildren || incomingDeps.length === 0 ? (
                      <span className="text-[11px] text-gray-300 w-full text-center">—</span>
                    ) : activeEditor?.taskId === t.id && activeEditor?.col === 'lag' ? (
                      <input autoFocus type="number"
                        className="text-[11px] border border-blue-400 rounded px-0.5 bg-white w-full focus:outline-none"
                        defaultValue={incomingDeps[0].lag ?? 0}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => {
                          const v = parseInt(e.target.value, 10) || 0
                          if (v !== (incomingDeps[0].lag ?? 0)) handleDepLagChange(incomingDeps[0].id, v)
                          setActiveEditor(null)
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          if (e.key === 'Escape') setActiveEditor(null)
                        }} />
                    ) : (
                      <span className="text-[11px] text-gray-600 w-full text-right">{incomingDeps[0].lag ?? 0}</span>
                    )}
                  </div>
                  )}

                  {/* ── 限制类型 ─────────────────────────────────── */}
                  {colCtypeW > 0 && (
                  <div style={{ width: colCtypeW, order: colOrderOf('ctype') }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('ctype')}`}
                       onClick={pickCell('ctype')}
                       onDoubleClick={e => { e.stopPropagation(); if (!row.hasChildren) setActiveEditor({ taskId: t.id, col: 'ctype' }) }}>
                    {row.hasChildren ? (
                      <span className="text-[11px] text-gray-300 w-full text-center">—</span>
                    ) : activeEditor?.taskId === t.id && activeEditor?.col === 'ctype' ? (
                      <select autoFocus
                        className="text-[11px] border border-blue-400 rounded px-0.5 bg-white text-gray-700 focus:outline-none cursor-pointer w-full"
                        value={t.constraint_type || DEFAULT_CONSTRAINT_TYPE}
                        onClick={e => e.stopPropagation()}
                        onBlur={() => setActiveEditor(null)}
                        onChange={e => { handleTaskFieldChange(t.id, { constraint_type: e.target.value }); setActiveEditor(null) }}>
                        {CONSTRAINT_TYPES.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[11px] text-gray-600 truncate w-full">
                        {CONSTRAINT_TYPES.find(c => c.value === (t.constraint_type || DEFAULT_CONSTRAINT_TYPE))?.label ?? ''}
                      </span>
                    )}
                  </div>
                  )}
                  {/* ── 限制日期 ─────────────────────────────────── */}
                  {colCdateW > 0 && (() => {
                    const ct = t.constraint_type || DEFAULT_CONSTRAINT_TYPE
                    const meta = CONSTRAINT_TYPES.find(c => c.value === ct)
                    const needsDate = !!meta?.needsDate && !row.hasChildren
                    const dv = (t.constraint_date ?? '').split('T')[0]
                    const editing = activeEditor?.taskId === t.id && activeEditor?.col === 'cdate'
                    return (
                      <div style={{ width: colCdateW, order: colOrderOf('cdate') }}
                           className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('cdate')}`}
                           onClick={e => { e.stopPropagation(); setSelectedCell({ taskId: t.id, col: 'cdate' }) }}
                           onDoubleClick={e => { e.stopPropagation(); if (needsDate) setActiveEditor({ taskId: t.id, col: 'cdate' }) }}>
                        {!needsDate ? (
                          <span className="text-[11px] text-gray-300 w-full text-center">—</span>
                        ) : editing ? (
                          <input autoFocus type="date"
                            className="text-[11px] border border-blue-400 rounded px-0.5 bg-white w-full focus:outline-none"
                            defaultValue={dv}
                            onClick={e => e.stopPropagation()}
                            onBlur={e => {
                              handleTaskFieldChange(t.id, { constraint_date: e.target.value || null })
                              setActiveEditor(null)
                            }}
                            onKeyDown={e => { if (e.key === 'Escape') setActiveEditor(null) }} />
                        ) : (
                          <span className="text-[11px] text-gray-600 w-full">{dv}</span>
                        )}
                      </div>
                    )
                  })()}
                  {/* ── 截止日期 ─────────────────────────────────── */}
                  {colDDateW > 0 && (() => {
                    if (row.hasChildren) {
                      return (
                        <div style={{ width: colDDateW, order: colOrderOf('ddate') }}
                             className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('ddate')}`}
                             onClick={pickCell('ddate')}>
                          <span className="text-[11px] text-gray-300 w-full text-center">—</span>
                        </div>
                      )
                    }
                    const dv = (t.deadline ?? '').split('T')[0]
                    const ev = (t.end_date ?? '').split('T')[0]
                    const overdue = !!(dv && ev && ev > dv)
                    const editing = activeEditor?.taskId === t.id && activeEditor?.col === 'ddate'
                    return (
                      <div style={{ width: colDDateW, order: colOrderOf('ddate') }}
                           className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('ddate')}`}
                           onClick={e => { e.stopPropagation(); setSelectedCell({ taskId: t.id, col: 'ddate' }) }}
                           onDoubleClick={e => { e.stopPropagation(); setActiveEditor({ taskId: t.id, col: 'ddate' }) }}
                           title={overdue ? `计划结束 ${ev} 已超过截止日期 ${dv}` : ''}>
                        {editing ? (
                          <input autoFocus type="date"
                            className="text-[11px] border border-blue-400 rounded px-0.5 bg-white w-full focus:outline-none"
                            defaultValue={dv}
                            onClick={e => e.stopPropagation()}
                            onBlur={e => {
                              handleTaskFieldChange(t.id, { deadline: e.target.value || null })
                              setActiveEditor(null)
                            }}
                            onKeyDown={e => { if (e.key === 'Escape') setActiveEditor(null) }} />
                        ) : dv ? (
                          <span className={`text-[11px] w-full ${overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                            {overdue && <span className="mr-0.5">⚠</span>}{dv}
                          </span>
                        ) : (
                          <span className="text-[11px] text-gray-300 w-full">—</span>
                        )}
                      </div>
                    )
                  })()}
                  {/* ── Percent done cell（与"状态"换位；read-only, based on status date） ── */}
                  {colPctW > 0 && (
                  <div style={{ width: colPctW, order: colOrderOf('pct') }}
                       className={`flex items-center justify-end border-r border-gray-100 h-full flex-none px-1 overflow-hidden ${cellRing('pct')}`}
                       onClick={pickCell('pct')}>
                    <span className="text-[11px] text-gray-600">
                      {t.is_milestone ? 100 : row.hasChildren ? (summaryProgressMap.get(t.id) ?? 0) : timeBasedPercent(t, statusDateObj)}%
                    </span>
                  </div>
                  )}
                  {/* ── 无效 ────────────────────────────────────── */}
                  {colInactiveW > 0 && (
                  <div style={{ width: colInactiveW, order: colOrderOf('inactive') }}
                       className={`flex items-center justify-center h-full flex-none px-1 overflow-hidden ${cellRing('inactive')}`}
                       onClick={pickCell('inactive')}>
                    <input type="checkbox"
                      checked={t.inactive ?? false}
                      onClick={e => e.stopPropagation()}
                      onChange={e => handleTaskFieldChange(t.id, { inactive: e.target.checked })}
                      className="w-4 h-4 accent-blue-500 cursor-pointer" />
                  </div>
                  )}
                </div>
              </React.Fragment>
            )
          })}
          {rowDrag?.dragging && dropIdx === flatRows.length && (
            <div style={{ height: 2, background: '#3b82f6' }} />
          )}
          {/* 补偿右侧水平滚动条高度，使左右面板底部对齐 */}
          {hScrollbarH > 0 && <div style={{ height: hScrollbarH, flexShrink: 0 }} />}
        </div>
       </div>
      </div>

      {/* ── Splitter ─────────────────────────────────────────────────── */}
      <div
        className="flex-none relative flex flex-col items-center justify-center select-none"
        style={{
          width: 6,
          background: splitterDrag ? '#dbeafe' : '#e5e7eb',
          cursor: 'col-resize',
          zIndex: 10,
        }}
        onMouseDown={e => {
          e.preventDefault()
          setSplitterDrag({ startX: e.clientX, startW: panelCollapsed ? 0 : panelW })
        }}
      >
        <div className="flex flex-col items-center rounded-full bg-white shadow-sm"
             style={{ border: '1px solid #d1d5db', padding: '2px 0' }}
             onMouseDown={e => e.stopPropagation()}
        >
          {/* Collapse / expand left panel */}
          <button
            title={panelCollapsed ? '展开左面板' : '折叠左面板'}
            style={{
              width: 14, height: 14, background: 'transparent', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', fontSize: 11, color: '#6b7280', lineHeight: 1,
            }}
            onClick={e => {
              e.stopPropagation()
              if (panelCollapsed) {
                setPanelCollapsed(false)
                setPanelW(prevPanelW.current)
              } else {
                prevPanelW.current = panelW
                setPanelCollapsed(true)
              }
            }}
          >
            {panelCollapsed ? '›' : '‹'}
          </button>
          {/* Collapse / expand right panel (timeline) */}
          <button
            title={rightCollapsed ? '展开右面板' : '折叠右面板'}
            style={{
              width: 14, height: 14, background: 'transparent', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', fontSize: 11,
              color: rightCollapsed ? '#2563eb' : '#6b7280', lineHeight: 1,
            }}
            onClick={e => {
              e.stopPropagation()
              setRightCollapsed(v => !v)
            }}
          >
            {rightCollapsed ? '‹' : '›'}
          </button>
        </div>
      </div>

      {/* ── Right timeline（上：日期头冻结；上下同步横向滚动，仅下方纵向滚动）──── */}
      <div className="flex flex-col min-h-0 bg-white"
           style={{ flex: rightCollapsed ? '0 0 0px' : '1 1 0%', overflow: 'hidden',
                    transition: splitterDrag ? undefined : 'flex 0.2s ease' }}>
        <div
          ref={rightHeaderRef}
          onScroll={onRightHeaderScroll}
          className="flex-none overflow-x-auto overflow-y-hidden shrink-0 border-b border-gray-300 bg-gray-50 scrollbar-hide"
          style={{ height: HDR_H + 4, minHeight: HDR_H + 4, flexShrink: 0 }}
        >
          <svg
            width={Math.max(totalW, 800)}
            height={HDR_H + 4}
            style={{ display: 'block', fontFamily: 'system-ui, sans-serif' }}
            overflow="visible"
          >
            <rect x={0} y={0} width={Math.max(totalW, 800)} height={HDR_H} fill="#f9fafb" />
            <line x1={0} y1={HDR_H} x2={Math.max(totalW, 800)} y2={HDR_H} stroke="#d1d5db" />
            {!isMinute ? (
              <>
                {/* ── 天级项目：月头 + 周/日（保持稳定版样式） ─── */}
                {(() => {
                  const months: { label: string; startD: number; endD: number }[] = []
                  let mStart = 0
                  let mLabel = ''
                  for (let d = 0; d <= totalDays; d++) {
                    const date  = addDays(origin, d)
                    const label = `${date.getFullYear()}年${date.getMonth()+1}月`
                    if (d === 0) { mStart = 0; mLabel = label }
                    else if (label !== mLabel || d === totalDays) {
                      months.push({ label: mLabel, startD: mStart, endD: d })
                      mStart = d; mLabel = label
                    }
                  }
                  return months.map((m, i) => {
                    const x = m.startD * colW
                    const w = (m.endD - m.startD) * colW
                    return (
                      <g key={`hm${i}`}>
                        <line x1={x} y1={0} x2={x} y2={HDR_H1} stroke="#d1d5db" />
                        <text x={x + w/2} y={HDR_H1-8} fontSize={11} textAnchor="middle"
                              fill="#374151" fontWeight="600">
                          {m.label}
                        </text>
                      </g>
                    )
                  })
                })()}
                {colW < 7
                  ? null
                  : colW < 14
                  ? (() => {
                      const nodes: React.ReactNode[] = []
                      for (let d = 0; d < totalDays; d += 7) {
                        const date = addDays(origin, d)
                        const x = d * colW
                        const w7 = Math.min(7, totalDays - d) * colW
                        nodes.push(
                          <g key={`hw${d}`}>
                            <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H} stroke="#d1d5db" />
                            <text x={x + w7 / 2} y={HDR_H - 6} fontSize={10} textAnchor="middle"
                                  fill="#374151" fontWeight={600}>
                              {`${date.getMonth()+1}/${date.getDate()}`}
                            </text>
                          </g>
                        )
                      }
                      return nodes
                    })()
                  : Array.from({ length: totalDays }, (_,d) => {
                      const date = addDays(origin,d)
                      const dow  = date.getDay()
                      const wknd = dow===0||dow===6
                      const x    = d*colW
                      return (
                        <g key={`hd${d}`}>
                          {wknd && (
                            <rect x={x} y={HDR_H1} width={colW} height={HDR_H - HDR_H1} fill="#f3f4f6" opacity={0.45} />
                          )}
                          <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H} stroke="#e5e7eb" />
                          <text x={x+colW/2} y={HDR_H - 6} fontSize={11} textAnchor="middle"
                                fill={wknd ? '#9ca3af' : '#374151'} fontWeight={600}>
                            {date.getDate()}
                          </text>
                        </g>
                      )
                    })
                }
              </>
            ) : colW >= 1440 ? (
              <>
                {/* ── 分钟级 + 高缩放：顶 = 日期+小时（每小时一格），二 = 15min ── */}
                {(() => {
                  // 顶层：每小时一格，标签 'MM-DD HH'
                  const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']
                  const hourW = colW / 24
                  const totalHours = totalDays * 24
                  const pad = (n: number) => String(n).padStart(2, '0')
                  const nodes: React.ReactNode[] = []
                  for (let h = 0; h < totalHours; h++) {
                    const d = Math.floor(h / 24)
                    const hh = h % 24
                    const date = addDays(origin, d)
                    const x = h * hourW
                    const isMidnight = hh === 0
                    const dow = date.getDay()
                    const wknd = dow === 0 || dow === 6
                    // 小时格标签自适应
                    const label = hourW < 50
                      ? `${pad(hh)}`
                      : hourW < 90
                      ? `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(hh)}`
                      : `${pad(date.getMonth()+1)}月${pad(date.getDate())}日(${WEEKDAY_CN[dow]}) ${pad(hh)}时`
                    nodes.push(
                      <g key={`hth${h}`}>
                        {wknd && (
                          <rect x={x} y={0} width={hourW} height={HDR_H1} fill="#f3f4f6" opacity={0.3} />
                        )}
                        <line x1={x} y1={0} x2={x} y2={HDR_H1}
                              stroke={isMidnight ? '#9ca3af' : '#e5e7eb'} />
                        <text x={x + hourW / 2} y={HDR_H1 - 8} fontSize={11} textAnchor="middle"
                              fill={wknd ? '#9ca3af' : '#374151'} fontWeight={isMidnight ? 700 : 600}>
                          {label}
                        </text>
                      </g>
                    )
                  }
                  return nodes
                })()}
                {(() => {
                  // 二级：15min 槽（每小时 4 格），标签 0/15/30/45
                  const slotW = colW / 96
                  const totalSlots = totalDays * 96
                  const showLabel = slotW >= 12
                  const nodes: React.ReactNode[] = []
                  for (let s = 0; s < totalSlots; s++) {
                    const slotInHour = s % 4
                    const mm = slotInHour * 15
                    const x = s * slotW
                    const isHourBoundary = slotInHour === 0
                    nodes.push(
                      <g key={`hs${s}`}>
                        <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H}
                              stroke={isHourBoundary ? '#d1d5db' : '#f3f4f6'} />
                        {showLabel && (
                          <text x={x + slotW / 2} y={HDR_H - 6} fontSize={9}
                                textAnchor="middle"
                                fill={isHourBoundary ? '#374151' : '#9ca3af'}>
                            {mm}
                          </text>
                        )}
                      </g>
                    )
                  }
                  return nodes
                })()}
              </>
            ) : (
              <>
                {/* ── 分钟级 + 默认：顶 = 日期(周X)，二 = 小时（每天 24 格）── */}
                {Array.from({ length: totalDays }, (_, d) => {
                  const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']
                  const date = addDays(origin, d)
                  const dow = date.getDay()
                  const wknd = dow === 0 || dow === 6
                  const x = d * colW
                  const wd = WEEKDAY_CN[dow]
                  const pad = (n: number) => String(n).padStart(2, '0')
                  const label = colW < 24
                    ? `${date.getDate()}`
                    : colW < 60
                    ? `${date.getDate()} ${wd}`
                    : colW < 180
                    ? `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日(${wd})`
                    : `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日(${wd})`
                  const prevDate = d > 0 ? addDays(origin, d - 1) : null
                  const monthBoundary = prevDate && prevDate.getMonth() !== date.getMonth()
                  return (
                    <g key={`htd${d}`}>
                      {wknd && (
                        <rect x={x} y={0} width={colW} height={HDR_H1} fill="#f3f4f6" opacity={0.4} />
                      )}
                      <line x1={x} y1={0} x2={x} y2={HDR_H1}
                            stroke={monthBoundary ? '#9ca3af' : '#e5e7eb'} />
                      {colW >= 7 && (
                        <text x={x + colW / 2} y={HDR_H1 - 8} fontSize={11} textAnchor="middle"
                              fill={wknd ? '#9ca3af' : '#374151'} fontWeight={600}>
                          {label}
                        </text>
                      )}
                    </g>
                  )
                })}
                {(() => {
                  // 二级：小时网格，标签密度自适应。任何能塞下数字的宽度都尽量显示。
                  const slotW = colW / 24
                  // 至少显示 0/12（或 0/6/12/18）的稀疏标签
                  const labelEvery =
                    slotW >= 50 ? 1
                    : slotW >= 28 ? 2
                    : slotW >= 16 ? 3
                    : slotW >= 8  ? 6
                    : slotW >= 4  ? 12
                    : 0
                  // 网格线密度：颜色按重要性区分
                  const showAllLines = slotW >= 8
                  const nodes: React.ReactNode[] = []
                  for (let d = 0; d < totalDays; d++) {
                    for (let hh = 0; hh < 24; hh++) {
                      const x = d * colW + hh * slotW
                      const isMidnight = hh === 0
                      const isMajor = labelEvery > 0 && hh % labelEvery === 0
                      // 不显示所有线时只显示标签对应的整点线
                      if (!showAllLines && !isMidnight && !isMajor) continue
                      const showLabel = labelEvery > 0 && hh % labelEvery === 0
                      nodes.push(
                        <g key={`hh${d}_${hh}`}>
                          <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H}
                                stroke={isMidnight ? '#d1d5db' : (isMajor ? '#e5e7eb' : '#f3f4f6')} />
                          {showLabel && (
                            <text x={x + slotW / 2} y={HDR_H - 6} fontSize={9}
                                  textAnchor="middle"
                                  fill={isMidnight ? '#374151' : '#6b7280'}>
                              {hh}
                            </text>
                          )}
                        </g>
                      )
                    }
                  }
                  return nodes
                })()}
              </>
            )}
            {/* Date markers aligned under day numbers */}
            {(() => {
              const nodes: React.ReactNode[] = []
              const LBL_Y = HDR_H
              const ps = currentProject?.start_date?.split('T')[0]
              let pe = currentProject?.end_date?.split('T')[0]
              if (!pe) {
                let mx = ''
                tasks.forEach(t => {
                  const d = t.end_date?.split('T')[0]
                  if (d && d > mx) mx = d
                })
                pe = mx || undefined
              }
              if (ps) {
                const x = dateToX(new Date(isMinute ? (currentProject?.start_date ?? ps) : ps + 'T00:00:00'))
                nodes.push(
                  <text key="lbl-ps" x={x-3} y={LBL_Y} fontSize={10} textAnchor="end"
                        fill="#dc2626" fontWeight={600}>{isMinute ? '开始时间' : '开始日期'}</text>
                )
              }
              if (statusDate) {
                const x = dateToX(new Date(statusDate))
                nodes.push(
                  <text key="lbl-sd" x={x-3} y={LBL_Y} fontSize={10} textAnchor="end"
                        fill="#ef4444" fontWeight={600}>{isMinute ? '状态时间' : '状态日期'}</text>
                )
              }
              if (pe) {
                const x = dateToX(new Date(isMinute ? (currentProject?.end_date ?? pe) : pe + 'T00:00:00'))
                nodes.push(
                  <text key="lbl-pe" x={x-3} y={LBL_Y} fontSize={10} textAnchor="end"
                        fill="#dc2626" fontWeight={600}>{isMinute ? '结束时间' : '结束日期'}</text>
                )
              }
              for (const pl of projectLines) {
                if (!pl.visible) continue
                const dateStr = (pl.line_date ?? '').split('T')[0]
                if (!dateStr) continue
                const x = dateToX(new Date(dateStr + 'T00:00:00'))
                nodes.push(
                  <text key={`lbl-pl-${pl.id}`} x={x+3} y={LBL_Y} fontSize={10}
                        fill={pl.color} fontWeight={600}>{pl.name}</text>
                )
              }
              return nodes
            })()}
          </svg>
        </div>
        <div
          ref={rightRef}
          onScroll={onRightBodyScroll}
          className="flex-1 overflow-auto min-h-0"
          style={{ cursor: drag ? 'ew-resize' : connect ? 'crosshair' : 'default' }}
        >
          <svg ref={svgRef}
               width={Math.max(totalW,800)} height={totalH+8}
               style={{ display:'block' }}
               onClick={() => setSelectedDep(null)}>
          <defs>
            <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#9ca3af" />
            </marker>
            <marker id="dep-arrow-sel" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#ef4444" />
            </marker>
            <marker id="connect-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#3b82f6" />
            </marker>
          </defs>

          {colW < 7
            ? /* 月视图：只画月分隔线 */
              (() => {
                const nodes: React.ReactNode[] = []
                let d = 0
                while (d < totalDays) {
                  const date = addDays(origin, d)
                  const x = d * colW
                  // 跳到下月1号
                  const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1)
                  const daysToNext = diffDays(date, nextMonth)
                  nodes.push(
                    <line key={`bm${d}`} x1={x} y1={0} x2={x} y2={totalH} stroke="#d1d5db" />
                  )
                  d += daysToNext || 1
                }
                return nodes
              })()
            : colW < 14
            ? /* 周视图：每7天画分隔线 */
              (() => {
                const nodes: React.ReactNode[] = []
                for (let d = 0; d < totalDays; d += 7) {
                  const x = d * colW
                  nodes.push(
                    <line key={`bw${d}`} x1={x} y1={0} x2={x} y2={totalH} stroke="#e5e7eb" />
                  )
                }
                return nodes
              })()
            : /* 日视图：每天画线 + 周末底色 */
              Array.from({ length: totalDays }, (_,d) => {
                const date = addDays(origin,d)
                const dow  = date.getDay()
                const wknd = dow===0||dow===6
                const x    = d*colW
                return (
                  <g key={`bd${d}`}>
                    {wknd && <rect x={x} y={0} width={colW} height={totalH} fill="#f3f4f6" opacity={0.5}/>}
                    <line x1={x} y1={0} x2={x} y2={totalH} stroke="#e5e7eb" />
                  </g>
                )
              })
          }

          {/* Row lines */}
          {displayRows.map((_,i)=>(
            <line key={`rl${i}`} x1={0} y1={(i+1)*ROW_H}
                  x2={totalW} y2={(i+1)*ROW_H} stroke="#e5e7eb" />
          ))}

          {/* Row highlights */}
          {displayRows.map((row,i)=>
            selectedIds.includes(row.task.id)
              ? <rect key={`sh${i}`} x={0} y={i*ROW_H} width={totalW} height={ROW_H}
                      fill="#dbeafe" opacity={0.35} />
              : null
          )}

          {/* Comparison baseline bars (版本对比 / 差异基线) */}
          {(showComparison || diffFilter) && comparisonMap.size > 0 && displayRows.map((row, i) => {
            const t = row.task
            const ct = comparisonMap.get(t.id)
            if (!ct?.start_date || !ct?.end_date) return null
            if (!t.start_date || !t.end_date) return null

            const cx = dateToX(new Date(ct.start_date))
            const cw = Math.max(colW * 0.4, dateToX(new Date(ct.end_date)) - cx)
            // 基线条位于当前任务条正下方
            const ch = diffFilter ? 10 : 7
            const cy = i * ROW_H + BAR_TOP + BAR_H + 1

            // 偏差：当前结束 vs 对比版本结束
            const endDelta = diffDays(new Date(ct.end_date), new Date(t.end_date))
            const startDelta = diffDays(new Date(ct.start_date), new Date(t.start_date))
            // 颜色：延后=红，提前=绿，准时=灰
            const barColor = endDelta > 0 ? '#ef4444' : endDelta < 0 ? '#22c55e' : '#9ca3af'
            const barOpacity = endDelta === 0 ? 0.4 : 0.6

            if (t.is_milestone) {
              const r = 5, mx = cx, my = cy + ch / 2
              return (
                <g key={`cmp-${t.id}`}>
                  <polygon
                    points={`${mx},${my-r} ${mx+r},${my} ${mx},${my+r} ${mx-r},${my}`}
                    fill={barColor} opacity={barOpacity} stroke={barColor} strokeWidth={1}
                  />
                  {endDelta !== 0 && (
                    <text x={mx + r + 6} y={my + 3} fontSize={9} fill={barColor} fontWeight="600" style={{ pointerEvents: 'none' }}>
                      {endDelta > 0 ? '+' : ''}{endDelta}d
                    </text>
                  )}
                </g>
              )
            }

            // 差异模式下用虚线边框突出基线条
            const rightEdge = Math.max(dateToX(new Date(t.end_date)), cx + cw) + 4
            return (
              <g key={`cmp-${t.id}`}>
                <rect x={cx} y={cy} width={cw} height={ch} fill={barColor} opacity={barOpacity} rx={2}
                  stroke={diffFilter ? barColor : 'none'} strokeWidth={diffFilter ? 0.8 : 0}
                  strokeDasharray={diffFilter ? '3,2' : 'none'} />
                {(startDelta !== 0 || endDelta !== 0) && (
                  <text
                    x={rightEdge}
                    y={cy + ch / 2 + 3}
                    fontSize={9}
                    fill={barColor}
                    fontWeight="600"
                    style={{ pointerEvents: 'none' }}
                  >
                    {startDelta !== 0 && `开始${startDelta > 0 ? '+' : ''}${startDelta}d`}
                    {startDelta !== 0 && endDelta !== 0 && '  '}
                    {endDelta !== 0 && `结束${endDelta > 0 ? '+' : ''}${endDelta}d`}
                  </text>
                )}
              </g>
            )
          })}

          {/* Dependency arrows — 渲染在 bar 之前，避免 10px 命中带覆盖任务条阻挡拖拽 */}
          {deps.map(dep => {
            let fi = rowIdx[dep.from_task_id]
            let ti = rowIdx[dep.to_task_id]
            // 如果任务不在可见行中（被折叠），找其最近可见祖先（防止循环引用）
            if (fi === undefined) {
              const seen = new Set<string>()
              let pid = tasks.find(t => t.id === dep.from_task_id)?.parent_id ?? null
              while (pid && !seen.has(pid)) {
                seen.add(pid)
                if (rowIdx[pid] !== undefined) { fi = rowIdx[pid]; break }
                pid = tasks.find(t => t.id === pid)?.parent_id ?? null
              }
            }
            if (ti === undefined) {
              const seen = new Set<string>()
              let pid = tasks.find(t => t.id === dep.to_task_id)?.parent_id ?? null
              while (pid && !seen.has(pid)) {
                seen.add(pid)
                if (rowIdx[pid] !== undefined) { ti = rowIdx[pid]; break }
                pid = tasks.find(t => t.id === pid)?.parent_id ?? null
              }
            }
            if (fi===undefined||ti===undefined) return null
            const ft = displayRows[fi].task
            const tt = displayRows[ti].task
            if (!ft.start_date||!ft.end_date||!tt.start_date||!tt.end_date) return null

            // 根据依赖类型选择起终点 X 坐标
            // 里程碑或日期异常时，确保 end >= start
            const fromStart = dateToX(new Date(ft.start_date))
            const fromEndRaw = dateToX(new Date(ft.end_date))
            const fromEnd   = Math.max(fromStart, fromEndRaw)
            const toStart   = dateToX(new Date(tt.start_date))
            const toEndRaw  = dateToX(new Date(tt.end_date))
            const toEnd     = Math.max(toStart, toEndRaw)

            let x1: number, x2: number
            const depType = Number(dep.type ?? 2)  // 确保数值类型，默认 FS
            if (depType === 0)      { x1 = fromStart; x2 = toStart }  // SS
            else if (depType === 1) { x1 = fromStart; x2 = toEnd   }  // SF
            else if (depType === 3) { x1 = fromEnd;   x2 = toEnd   }  // FF
            else                    { x1 = fromEnd;   x2 = toStart }  // FS (default)

            const y1   = fi*ROW_H + ROW_H/2
            const y2   = ti*ROW_H + ROW_H/2
            const bend = 10
            const isSel = selectedDep === dep.id

            // 起点从左侧出发时向左弯，从右侧出发时向右弯
            const exitRight = depType === 2 || depType === 3  // FS/FF 从 end 出发 → 向右
            const enterLeft = depType === 0 || depType === 2  // SS/FS 到 start → 从左进入
            const dx1 = exitRight ? bend : -bend
            const dx2 = enterLeft ? -bend : bend

            let d: string
            if ((exitRight && x2 > x1+bend*2) || (!exitRight && x2 > x1)) {
              // 目标在右侧 — 简单路径
              d = `M${x1},${y1} H${x1+dx1} V${y2} H${x2}`
            } else {
              // 目标在左侧 — 绕行路径
              const midY = Math.min(y1,y2)-8
              d = `M${x1},${y1} H${x1+dx1} V${midY} H${x2+dx2} V${y2} H${x2}`
            }

            const midPtX = (x1+x2)/2
            const midPtY = (y1+y2)/2
            const isDragTarget = depDrag?.depId === dep.id && depDrag.dragging
            return (
              <g key={dep.id}>
                <path d={d} stroke="transparent" strokeWidth={10} fill="none"
                      style={{ cursor: readOnly ? 'pointer' : 'ew-resize' }}
                      onClick={e=>{
                        e.stopPropagation()
                        // 若刚完成拖拽则不触发选中切换
                        if (depDragJustEndedRef.current) {
                          depDragJustEndedRef.current = false
                          return
                        }
                        setSelectedDep(isSel?null:dep.id)
                      }}
                      onMouseDown={e=>onDepLineMouseDown(e, dep, midPtX, midPtY)} />
                <path d={d}
                      stroke={isDragTarget ? '#3b82f6' : isSel ? '#ef4444' : (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? '#ef4444' : '#9ca3af'}
                      strokeWidth={isDragTarget ? 2.5 : isSel ? 2 : (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? 2 : 1.5}
                      strokeDasharray={isDragTarget ? '5 3' : undefined}
                      fill="none" markerEnd={`url(#dep-arrow${isDragTarget || isSel || (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? '-sel' : ''})`}
                      style={{ pointerEvents:'none' }} />
                {isSel && (() => {
                  const mx = (x1+x2)/2, my = (y1+y2)/2
                  const lag = dep.lag ?? 0
                  const lagLabel = `延迟 ${fmtMinDur(lag, { signed: true })}`
                  const badgeW = Math.max(72, lagLabel.length * 8 + 12)
                  const badgeH = 20
                  const bx = mx - badgeW / 2
                  const by = my - 28
                  return (
                    <>
                      {/* 延迟标签（只读展示，点击不触发删除） */}
                      <g style={{ pointerEvents:'none' }}>
                        <rect x={bx} y={by} width={badgeW} height={badgeH} rx={4}
                              fill="#1e40af" opacity={0.92} />
                        <text x={mx} y={by + 14} textAnchor="middle"
                              fontSize={11} fill="white" fontWeight="bold">
                          {lagLabel}
                        </text>
                      </g>
                      {/* 删除按钮 */}
                      <g style={{ cursor:'pointer' }}
                         onClick={e=>{
                           e.stopPropagation()
                           dispatch(removeDependency(dep.id))
                           const remainDeps = deps.filter(d => d.id !== dep.id)
                           recascade(remainDeps)
                           setSelectedDep(null)
                         }}>
                        <circle cx={mx} cy={my} r={9} fill="#ef4444" />
                        <text x={mx} y={my+4} textAnchor="middle" fontSize={12}
                              fill="white" fontWeight="bold" style={{ pointerEvents:'none' }}>
                          ×
                        </text>
                      </g>
                    </>
                  )
                })()}
              </g>
            )
          })}

          {/* Task bars */}
          {displayRows.map((row,i) => {
            const t = row.task
            if (!t.start_date || !t.end_date) return null
            const x  = dateToX(new Date(t.start_date))
            const w  = Math.max(colW*0.4, dateToX(new Date(t.end_date))-x)
            const y  = i*ROW_H + BAR_TOP
            const isDragging = !!previewMap[t.id]

            const inactiveDim = inactiveSet.has(t.id) ? 0.35 : 1

            // 截止日期标记：红色虚线 + 超期时标记超出段
            const deadlineStr = t.deadline ? String(t.deadline).split('T')[0] : null
            const endStrForDL = t.end_date ? String(t.end_date).split('T')[0] : null
            const overdue = !!(deadlineStr && endStrForDL && endStrForDL > deadlineStr) && !row.hasChildren
            const deadlineX = deadlineStr ? dateToX(new Date(deadlineStr + 'T00:00:00')) : null
            const deadlineMarker = indicators.deadlineDate && deadlineStr && deadlineX != null && !row.hasChildren ? (
              <g style={{ pointerEvents: 'none' }}>
                <line x1={deadlineX} y1={y-3} x2={deadlineX} y2={y+BAR_H+3}
                      stroke="#dc2626" strokeWidth={1.5} strokeDasharray="3,2" />
                <polygon points={`${deadlineX},${y-5} ${deadlineX+7},${y-2} ${deadlineX},${y+1}`} fill="#dc2626" />
                {overdue && deadlineX < x + w && (
                  <rect x={Math.max(deadlineX, x)} y={y}
                        width={(x + w) - Math.max(deadlineX, x)} height={BAR_H}
                        fill="#dc2626" opacity={0.28} rx={2} />
                )}
                {overdue && (
                  <text x={x + w + 4} y={y + BAR_H/2 + 3} fontSize={10}
                        fill="#dc2626" fontWeight="700">⚠ 超期</text>
                )}
              </g>
            ) : null

            // 限制日期标记：紫色菱形（位置+方向提示限制类型）
            const cDateStr = t.constraint_date ? String(t.constraint_date).split('T')[0] : null
            const cTypeStr = t.constraint_type || null
            const cDateX = cDateStr ? dateToX(new Date(cDateStr + 'T00:00:00')) : null
            const constraintMarker = indicators.constraintDate && cDateStr && cDateX != null && !row.hasChildren ? (() => {
              const cy = y + BAR_H/2
              const r = 4
              const arrow = cTypeStr === 'startnoearlierthan'
                ? <polygon points={`${cDateX+r+1},${cy-3} ${cDateX+r+5},${cy} ${cDateX+r+1},${cy+3}`} fill="#7c3aed" />
                : cTypeStr === 'finishnolaterthan'
                ? <polygon points={`${cDateX-r-1},${cy-3} ${cDateX-r-5},${cy} ${cDateX-r-1},${cy+3}`} fill="#7c3aed" />
                : null
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <line x1={cDateX} y1={y-3} x2={cDateX} y2={y+BAR_H+3}
                        stroke="#7c3aed" strokeWidth={1.2} strokeDasharray="2,2" opacity={0.7} />
                  <polygon points={`${cDateX},${cy-r} ${cDateX+r},${cy} ${cDateX},${cy+r} ${cDateX-r},${cy}`}
                           fill="#ede9fe" stroke="#7c3aed" strokeWidth={1.2} />
                  {arrow}
                </g>
              )
            })() : null

            if (t.is_milestone) {
              const r=BAR_H/2, cx=x, cy=y+r
              const hovered = hoveredBar === t.id
              return (
                <g key={t.id}
                   style={{ cursor:'pointer', opacity: (isDragging?0.7:1) * inactiveDim }}
                   onMouseEnter={()=>setHoveredBar(t.id)}
                   onMouseLeave={()=>setHoveredBar(null)}
                   onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); if (!readOnly) setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                   onMouseDown={e=>{
                     if (e.button!==0) return
                     e.stopPropagation()
                     setDrag({
                       taskId:t.id, mode:'move',
                       startMouseX: getSvgX(e.clientX),
                       origStart: new Date(t.start_date!),
                       origEnd: new Date(t.end_date!),
                       dragging: false,
                     })
                     setPreviewMap({ [t.id]: { ...t } })
                   }}>
                  <text x={cx-r-4} y={cy+4} fontSize={11} textAnchor="end" fill="#6b7280" style={{ pointerEvents:'none' }}>{t.name}</text>
                  <polygon points={`${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}`}
                           fill="#fbbf24" stroke="#f59e0b" strokeWidth={1} />
                  {/* Connect circle for creating dependencies */}
                  {hovered && (
                    <circle cx={cx+r+6} cy={cy} r={6}
                            fill="#3b82f6" stroke="white" strokeWidth={1.5}
                            style={{ cursor:'crosshair' }}
                            onMouseDown={e=>{ e.stopPropagation(); onConnectMouseDown(e,t,i) }} />
                  )}
                  {deadlineMarker}
                  {constraintMarker}
                </g>
              )
            }

            if (row.hasChildren) {
              const capH=6, capW=10
              const sPct = summaryProgressMap.get(t.id) ?? 0
              const sDoneW = w * Math.max(0, Math.min(1, sPct / 100))
              return (
                <g key={t.id}
                   onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); if (!readOnly) setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                   onMouseDown={e=>{ if(e.button!==0)return; onBarMouseDown(e,t) }}
                   style={{ cursor:'grab', opacity: (isDragging?0.7:1) * inactiveDim }}>
                  <text x={x-4} y={y+BAR_H/2+4} fontSize={11} textAnchor="end" fill="#6b7280" fontWeight="600" style={{ pointerEvents:'none' }}>{t.name}</text>
                  <rect x={x} y={y} width={w} height={BAR_H} fill="#93c5fd" rx={3} opacity={0.9}/>
                  {sDoneW > 0.5 && (
                    <rect x={x} y={y} width={sDoneW} height={BAR_H} fill="#3b82f6" rx={3} opacity={0.9}/>
                  )}
                  <polygon points={`${x},${y+BAR_H} ${x+capW},${y+BAR_H} ${x},${y+BAR_H+capH}`} fill="#60a5fa"/>
                  <polygon points={`${x+w},${y+BAR_H} ${x+w-capW},${y+BAR_H} ${x+w},${y+BAR_H+capH}`} fill="#60a5fa"/>
                  <text x={x+w+4} y={y+BAR_H/2+4} fontSize={10} fill="#3b82f6" fontWeight="600" style={{ pointerEvents:'none' }}>{sPct}%</text>
                </g>
              )
            }

            const pct   = Math.max(0, Math.min(1, timeBasedPercent(t, statusDateObj) / 100))
            const doneW = w * pct
            const hovered = hoveredBar === t.id
            const isCritical = criticalSet.has(t.id)
            // 关键路径：红色调；普通：绿色调
            const barBg   = isCritical ? '#fca5a5' : '#86efac'
            const barDone = isCritical ? '#f87171' : '#4ade80'
            const barText = isCritical ? '#7f1d1d' : '#14532d'

            return (
              <g key={t.id} style={{ opacity: (isDragging?0.65:1) * inactiveDim }}
                 onMouseEnter={()=>setHoveredBar(t.id)}
                 onMouseLeave={()=>setHoveredBar(null)}
                 onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); if (!readOnly) setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                 onMouseMove={(e) => {
                   // 动态更新光标样式
                   const mouseX = getSvgX(e.clientX)
                   const EDGE_SIZE = 15
                   let cursor = 'grab'
                   // 短条整体平移，不显示 resize 光标
                   if (w > EDGE_SIZE * 2) {
                     if (mouseX < x + EDGE_SIZE) cursor = 'ew-resize'
                     else if (mouseX > x + w - EDGE_SIZE) cursor = 'ew-resize'
                   }
                   e.currentTarget.style.cursor = cursor
                 }}>
                {/* 任务名称（条左侧） */}
                <text x={x-4} y={y+BAR_H/2+4} fontSize={11} textAnchor="end" fill="#6b7280" style={{ pointerEvents:'none' }}>{t.name}</text>
                {/* 任务条背景（整个区域，无交互） */}
                <rect x={x} y={y} width={w} height={BAR_H} fill={barBg} rx={3}
                      style={{ pointerEvents:'none' }} />
                {doneW>0.5 && (
                  <rect x={x} y={y} width={doneW} height={BAR_H} fill={barDone} rx={3}
                        style={{ pointerEvents:'none' }} />
                )}
                {w>40 && pct>0 && (
                  <text x={x+w/2} y={y+BAR_H/2+4} fontSize={9} textAnchor="middle"
                        fill={barText} fontWeight="600" style={{ pointerEvents:'none' }}>
                    {Math.round(pct*100)}%
                  </text>
                )}
                {/* 边缘高亮提示：hover时显示左右边缘的resize区域 */}
                {hovered && w > 30 && (
                  <>
                    {/* 左边缘提示 */}
                    <rect x={x} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3}
                          style={{ pointerEvents:'none' }} />
                    {/* 右边缘提示 */}
                    <rect x={x+w-15} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3}
                          style={{ pointerEvents:'none' }} />
                  </>
                )}
                {/* 单一交互层：根据鼠标位置自动判断操作类型 */}
                <rect x={x} y={y} width={w} height={BAR_H} fill="transparent"
                      onMouseDown={e=>onBarMouseDown(e,t)}
                      style={{ cursor:'grab' }} />
                {hovered && (
                  <circle cx={x+w+6} cy={y+BAR_H/2} r={6}
                          fill="#3b82f6" stroke="white" strokeWidth={1.5}
                          style={{ cursor:'crosshair' }}
                          onMouseDown={e=>{ e.stopPropagation(); onConnectMouseDown(e,t,i) }} />
                )}
                {deadlineMarker}
                {constraintMarker}
              </g>
            )
          })}

          {/* Live connect line */}
          {connect && (
            <path d={`M${connect.fromX},${connect.fromY} L${connect.curX},${connect.curY}`}
                  stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3" fill="none"
                  markerEnd="url(#connect-arrow)" style={{ pointerEvents:'none' }} />
          )}

          {/* 依赖线拖拽中的 lag 提示 */}
          {depDrag && depDrag.dragging && (() => {
            const newLag = depDrag.startLag + depDrag.deltaDays
            const label = `延迟 ${fmtMinDur(newLag, { signed: true })}`
            const badgeW = Math.max(72, label.length * 9)
            const bx = depDrag.labelX - badgeW/2
            const by = depDrag.labelY - 28
            return (
              <g style={{ pointerEvents:'none' }}>
                <rect x={bx} y={by} width={badgeW} height={22} rx={4}
                      fill="#1e40af" opacity={0.92} />
                <text x={depDrag.labelX} y={by+15} textAnchor="middle"
                      fontSize={12} fill="white" fontWeight="bold">
                  {label}
                </text>
              </g>
            )
          })()}

          {/* Status date */}
          {statusDate && (() => {
            const sx = dateToX(new Date(statusDate))
            return (
              <g>
                <line x1={sx} y1={0} x2={sx} y2={totalH}
                      stroke="#ef4444" strokeWidth={2} strokeDasharray="5 3" />
              </g>
            )
          })()}

          {/* Project start / end lines */}
          {(() => {
            const nodes: React.ReactNode[] = []
            const ps = currentProject?.start_date?.split('T')[0]
            let pe = currentProject?.end_date?.split('T')[0]
            if (!pe) {
              let mx = ''
              tasks.forEach(t => {
                const d = t.end_date?.split('T')[0]
                if (d && d > mx) mx = d
              })
              pe = mx || undefined
            }
            if (ps) {
              const px = dateToX(new Date(ps + 'T00:00:00'))
              nodes.push(
                <g key="proj-start">
                  <line x1={px} y1={0} x2={px} y2={totalH}
                        stroke="#dc2626" strokeWidth={2} strokeDasharray="4 4" />
                </g>
              )
            }
            if (pe) {
              const px = dateToX(new Date(pe + 'T00:00:00'))
              nodes.push(
                <g key="proj-end">
                  <line x1={px} y1={0} x2={px} y2={totalH}
                        stroke="#dc2626" strokeWidth={2} strokeDasharray="4 4" />
                </g>
              )
            }
            return nodes
          })()}

          {/* Project lines (label is rendered in the header SVG, aligned with 开始日期/结束日期) */}
          {projectLines.filter(pl => pl.visible).map(pl => {
            const dateStr = (pl.line_date ?? '').split('T')[0]
            if (!dateStr) return null
            const px = dateToX(new Date(dateStr + 'T00:00:00'))
            return (
              <g key={pl.id}>
                <line x1={px} y1={0} x2={px} y2={totalH}
                      stroke={pl.color} strokeWidth={2} strokeDasharray="4 4" />
              </g>
            )
          })}
        </svg>
        </div>
      </div>

      {/* ── Context menu ─────────────────────────────────────────────── */}
      {ctxMenu && (() => {
        const task     = tasks.find(t => t.id === ctxMenu.taskId)
        if (!task) return null
        const taskDeps = deps.filter(d => d.from_task_id === ctxMenu.taskId || d.to_task_id === ctxMenu.taskId)
        const hasDeps  = taskDeps.length > 0
        const prevSibling = tasks
          .filter(t => t.parent_id === task.parent_id && t.order_index < task.order_index)
          .sort((a, b) => b.order_index - a.order_index)[0]
        const canIndent  = !!prevSibling
        const canOutdent = !!task.parent_id
        const isSummary = summarySet.has(ctxMenu.taskId)
        const depCandidates = tasks.filter(t => t.id !== ctxMenu.taskId && !summarySet.has(t.id))

        // Smart positioning: clamp to viewport
        const menuH = 520
        const menuW = 240
        const pad = 8
        const top = ctxMenu.y + menuH > window.innerHeight - pad
          ? Math.max(pad, window.innerHeight - menuH - pad)
          : ctxMenu.y
        const left = ctxMenu.x + menuW > window.innerWidth - pad
          ? Math.max(pad, ctxMenu.x - menuW)
          : ctxMenu.x

        const Sep = () => <div className="my-1 border-t border-gray-100" />

        const Row = ({ icon, label, onClick, disabled = false, danger = false, sub = false }: {
          icon: React.ReactNode; label: string; onClick?: () => void
          disabled?: boolean; danger?: boolean; sub?: boolean
        }) => (
          <button
            disabled={disabled}
            onClick={!disabled ? onClick : undefined}
            onMouseEnter={() => !sub && setCtxMenu(p => p ? { ...p, submenu: null } : null)}
            className={`w-full flex items-center gap-3 px-4 py-[7px] text-[13px] whitespace-nowrap transition-colors
              ${disabled
                ? 'text-gray-300 cursor-default'
                : danger
                  ? 'text-gray-700 hover:bg-red-50 hover:text-red-600 cursor-pointer'
                  : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer'}`}>
            <span className="w-4 flex-none flex items-center justify-center opacity-70">{icon}</span>
            <span className="flex-1 text-left">{label}</span>
          </button>
        )

        const SubRow = ({ icon, label, sub }: { icon: React.ReactNode; label: string; sub: 'add' | 'add-dep' | 'delete-dep' }) => (
          <div className="relative"
               onMouseEnter={(e) => {
                 const rect = e.currentTarget.getBoundingClientRect()
                 const subMenuW = 200
                 const x = rect.right + subMenuW > window.innerWidth ? rect.left - subMenuW : rect.right
                 setCtxMenu(p => p ? { ...p, submenu: sub, subX: x, subY: rect.top } : null)
               }}>
            <button className="w-full flex items-center gap-3 px-4 py-[7px] text-[13px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer whitespace-nowrap transition-colors">
              <span className="w-4 flex-none flex items-center justify-center opacity-70">{icon}</span>
              <span className="flex-1 text-left">{label}</span>
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-gray-400">
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )

        // Icons
        const IcoEdit    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 2l3 3-8 8H3v-3L11 2z"/></svg>
        const IcoCopy    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8" strokeLinecap="round"/></svg>
        const IcoCut     = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="4" cy="12" r="2"/><circle cx="4" cy="4" r="2"/><path d="M6 11L14 3M6 5l8 8" strokeLinecap="round"/></svg>
        const IcoPaste   = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 3h6v2H5V3z"/><rect x="3" y="4" width="10" height="10" rx="1"/></svg>
        const IcoAdd     = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10" strokeLinecap="round"/></svg>
        const IcoDiamond = <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 2l4 6-4 6-4-6z"/></svg>
        const IcoIndent  = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 4h12M2 8h8M2 12h12M10 6l3 2-3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        const IcoOutdent = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 4h12M6 8h8M2 12h12M6 6L3 8l3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        const IcoTrash   = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 5h10M6 5V3h4v2M7 8v4M9 8v4" strokeLinecap="round"/><path d="M4 5l1 9h6l1-9H4z"/></svg>
        const IcoLink    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 10l-1 1a3 3 0 004.24 0l3-3a3 3 0 00-4.24-4.24L7 5" strokeLinecap="round"/><path d="M10 6l1-1a3 3 0 00-4.24 0L4 8a3 3 0 004.24 4.24L9 11" strokeLinecap="round"/></svg>
        const IcoUnlink  = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 10l-1 1a3 3 0 004.24 0l3-3a3 3 0 00-4.24-4.24L7 5M3 3l10 10" strokeLinecap="round"/></svg>
        const IcoAuto    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 2L3 7h3v6h4V7h3L8 2z"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/></svg>

        return (
          <div
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-2xl py-1.5 text-[13px] select-none overflow-y-auto"
            style={{ left, top, minWidth: 220, maxHeight: `calc(100vh - ${pad * 2}px)` }}
            onClick={e => e.stopPropagation()}
          >
            {/* Group 1: Edit / Copy / Cut / Paste */}
            <Row icon={IcoEdit}  label="编辑"  onClick={() => handleCtxEdit(ctxMenu.taskId)} />
            <Row icon={IcoCopy}  label="复制"  onClick={() => handleCtxCopy(ctxMenu.taskId)} />
            <Row icon={IcoCut}   label="剪切"  onClick={() => handleCtxCut(ctxMenu.taskId)} />
            <Row icon={IcoPaste} label="粘贴"  onClick={handleCtxPaste} disabled={clipboard.length === 0} />

            <Sep />

            {/* Group 2: Add submenu */}
            <SubRow icon={IcoAdd} label="新增..." sub="add" />

            <Sep />

            {/* Group 3: Convert to milestone */}
            <Row icon={IcoDiamond}
                 label={task.is_milestone ? '转换为普通任务' : '转换为里程碑'}
                 onClick={() => handleCtxConvertMilestone(ctxMenu.taskId)} />

            <Sep />

            {/* Group 4: Indent / Outdent */}
            <Row icon={IcoIndent}  label="降级 (Indent)"  onClick={() => handleCtxIndent(ctxMenu.taskId)}  disabled={!canIndent} />
            <Row icon={IcoOutdent} label="升级 (Outdent)" onClick={() => handleCtxOutdent(ctxMenu.taskId)} disabled={!canOutdent} />

            <Sep />

            {/* Group 5: Delete */}
            <Row icon={IcoTrash} label="删除任务" onClick={() => handleCtxDeleteTask(ctxMenu.taskId)} danger />

            <Sep />

            {/* Group 6: Dependencies — 父级任务不允许依赖 */}
            {isSummary
              ? <Row icon={IcoLink} label="添加依赖关系" disabled />
              : <SubRow icon={IcoLink} label="添加依赖关系" sub="add-dep" />}
            {isSummary
              ? <Row icon={IcoUnlink} label="删除依赖关系" disabled />
              : hasDeps
                ? <SubRow icon={IcoUnlink} label="删除依赖关系" sub="delete-dep" />
                : <Row    icon={IcoUnlink} label="删除依赖关系" disabled />}

            <Sep />

            {/* Group 7: Auto Schedule */}
            <Row icon={IcoAuto} label="批量启用自动排程" onClick={handleEnableAutoSchedule} />
            <Row icon={IcoAuto} label="修复任务日期" onClick={handleFixProjectDates} />
          </div>
        )
      })()}

      {/* ── 延期原因 popover (portal) ────────────────────────────────── */}
      {reasonPopup && ReactDOM.createPortal(
        <div className="fixed bg-white border border-orange-300 rounded-md shadow-lg p-2.5 text-[12px] max-w-[320px] z-[70]"
             style={{ left: reasonPopup.x, top: reasonPopup.y }}
             onMouseDown={e => e.stopPropagation()}>
          <div className="text-[11px] text-gray-500 mb-1">填报原因 · {reasonPopup.taskName}</div>
          <div className="text-gray-800 whitespace-pre-wrap break-words">{reasonPopup.reason}</div>
        </div>,
        document.body,
      )}

      {/* ── Context submenu (portal) ─────────────────────────────────── */}
      {ctxMenu?.submenu && ctxMenu.subX != null && ctxMenu.subY != null && ReactDOM.createPortal(
        <div className="fixed bg-white border border-gray-200 rounded-lg shadow-2xl py-1 text-[13px] overflow-y-auto z-[60]"
             style={{ minWidth: 180, maxHeight: 320, left: ctxMenu.subX, top: ctxMenu.subY }}
             onClick={e => e.stopPropagation()}>
          {ctxMenu.submenu === 'add' && ([
            ['上方插入任务',  () => handleCtxAddAbove(ctxMenu.taskId)],
            ['下方插入任务',  () => handleCtxAddBelow(ctxMenu.taskId)],
            ['添加里程碑',   () => handleCtxAddMilestone(ctxMenu.taskId)],
            ['添加子任务',   () => handleCtxAddSubtask(ctxMenu.taskId)],
            ['添加后续任务', () => handleCtxAddSuccessor(ctxMenu.taskId)],
            ['添加前置任务', () => handleCtxAddPredecessor(ctxMenu.taskId)],
          ] as [string, () => void][]).map(([lbl, fn]) => (
            <button key={lbl} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap" onClick={fn}>{lbl}</button>
          ))}
          {ctxMenu.submenu === 'add-dep' && tasks.filter(t => t.id !== ctxMenu.taskId && !summarySet.has(t.id)).map(t => (
            <button key={t.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap truncate max-w-[220px]"
                    onClick={() => handleCtxAddDep(ctxMenu.taskId, t.id)}>
              {t.name}
            </button>
          ))}
          {ctxMenu.submenu === 'delete-dep' && deps.filter(d => d.from_task_id === ctxMenu.taskId || d.to_task_id === ctxMenu.taskId).map(dep => {
            const from = tasks.find(t => t.id === dep.from_task_id)
            const to   = tasks.find(t => t.id === dep.to_task_id)
            return (
              <button key={dep.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-red-50 hover:text-red-600 whitespace-nowrap truncate max-w-[220px]"
                      onClick={() => handleCtxDeleteDep(dep.id)}>
                {from?.name ?? '?'} → {to?.name ?? '?'}
              </button>
            )
          })}
        </div>,
        document.body
      )}

      {/* ── Predecessor popup ────────────────────────────────────────── */}
      {predPopup && !summarySet.has(predPopup.taskId) && (() => {
        // 排序与左侧任务列表一致（按序号升序）
        const candidateTasks = tasks
          .filter(t => t.id !== predPopup.taskId && !t.is_deleted && !summarySet.has(t.id))
          .sort((a, b) => (seqMap.get(a.id) ?? 99999) - (seqMap.get(b.id) ?? 99999))
        const filterLower = predFilter.toLowerCase()
        const filtered = filterLower
          ? candidateTasks.filter(t =>
              t.name.toLowerCase().includes(filterLower)
              || (flatRowIdx[t.id] ?? '').includes(filterLower)
            )
          : candidateTasks
        return (
          <>
            <div
              className="fixed inset-0 z-[49]"
              onClick={() => setPredPopup(null)}
              aria-hidden
            />
            <div
              className="fixed z-[50] bg-white border border-gray-200 rounded-lg shadow-2xl"
              style={{ left: predPopup.x, top: predPopup.y, width: 300, maxHeight: 320 }}
              onClick={e => e.stopPropagation()}
            >
            {/* Filter input */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
              <span className="text-gray-400 text-xs">▼</span>
              <input
                autoFocus
                placeholder="搜索任务..."
                value={predFilter}
                onChange={e => setPredFilter(e.target.value)}
                className="flex-1 text-[12px] outline-none text-gray-700 placeholder-gray-400"
              />
            </div>
            {/* Task list */}
            <div className="overflow-y-auto" style={{ maxHeight: 260 }}>
              {filtered.map(task => {
                const isPred = deps.some(d => d.from_task_id === task.id && d.to_task_id === predPopup.taskId)
                const rowNum = flatRowIdx[task.id]
                return (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 cursor-pointer"
                    onClick={() => togglePredecessor(task.id, predPopup.taskId)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePredecessor(task.id, predPopup.taskId) } }}
                  >
                    <span className="flex-none w-3.5 h-3.5 rounded border flex items-center justify-center"
                          style={{ background: isPred ? '#3b82f6' : 'transparent', borderColor: isPred ? '#3b82f6' : '#9ca3af' }}>
                      {isPred && <span className="text-white text-[10px]">✓</span>}
                    </span>
                    <span className="text-[11px] text-gray-400 flex-none w-6 text-right">{rowNum}</span>
                    <span className="text-[12px] text-gray-700 truncate">{task.name}</span>
                  </div>
                )
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-gray-400 text-center">无匹配任务</div>
              )}
            </div>
          </div>
          </>
        )
      })()}
      {/* ── Successor popup ──────────────────────────────────────────── */}
      {succPopup && !summarySet.has(succPopup.taskId) && (() => {
        const candidateTasks = tasks
          .filter(t => t.id !== succPopup.taskId && !t.is_deleted && !summarySet.has(t.id))
          .sort((a, b) => (seqMap.get(a.id) ?? 99999) - (seqMap.get(b.id) ?? 99999))
        const filterLower = succFilter.toLowerCase()
        const filtered = filterLower
          ? candidateTasks.filter(t =>
              t.name.toLowerCase().includes(filterLower)
              || (flatRowIdx[t.id] ?? '').includes(filterLower)
            )
          : candidateTasks
        return (
          <>
            <div className="fixed inset-0 z-[49]" onClick={() => setSuccPopup(null)} aria-hidden />
            <div className="fixed z-[50] bg-white border border-gray-200 rounded-lg shadow-2xl"
                 style={{ left: succPopup.x, top: succPopup.y, width: 300, maxHeight: 320 }}
                 onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
                <span className="text-gray-400 text-xs">▼</span>
                <input autoFocus placeholder="搜索任务..." value={succFilter}
                       onChange={e => setSuccFilter(e.target.value)}
                       className="flex-1 text-[12px] outline-none text-gray-700 placeholder-gray-400" />
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 260 }}>
                {filtered.map(task => {
                  const isSucc = deps.some(d => d.from_task_id === succPopup.taskId && d.to_task_id === task.id)
                  const rowNum = flatRowIdx[task.id]
                  return (
                    <div key={task.id} role="button" tabIndex={0}
                         className="flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 cursor-pointer"
                         onClick={() => togglePredecessor(succPopup.taskId, task.id)}
                         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePredecessor(succPopup.taskId, task.id) } }}>
                      <span className="flex-none w-3.5 h-3.5 rounded border flex items-center justify-center"
                            style={{ background: isSucc ? '#3b82f6' : 'transparent', borderColor: isSucc ? '#3b82f6' : '#9ca3af' }}>
                        {isSucc && <span className="text-white text-[10px]">✓</span>}
                      </span>
                      <span className="text-[11px] text-gray-400 flex-none w-6 text-right">{rowNum}</span>
                      <span className="text-[12px] text-gray-700 truncate">{task.name}</span>
                    </div>
                  )
                })}
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-[12px] text-gray-400 text-center">无匹配任务</div>
                )}
              </div>
            </div>
          </>
        )
      })()}
      {/* ── Post-create edit modal ───────────────────────────────────── */}
      {editModalTaskId && (
        <EditTaskModal
          taskId={editModalTaskId}
          projectId={projectId}
          onClose={() => setEditModalTaskId(null)}
        />
      )}
    </div>
  )
}
