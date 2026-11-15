'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { undoDraft, type DraftSnapshot } from '@/store/draftHistory'
import { buildScheduleImpact, dependencyTypeName, type ImpactCategory } from '@/lib/scheduleImpact'
import { formatMinDuration, toDateTimeStr } from '@/lib/clientTime'
import type { Dependency } from '@/types'

const categories: Record<ImpactCategory, string> = { direct: '直接操作', cascade: '自动级联', summary: '摘要汇总', manual: '手动保留', other: '其他变化' }
const PAGE_SIZE = 50
const EMPTY_DESCRIPTIONS = {}
const deltaLabel = (value: number | null) => value == null ? '—' : value === 0 ? '不变' : `${value < 0 ? '提前' : '延后'} ${formatMinDuration(value)}`
const depLabel = (dep?: Dependency) => dep ? `${dependencyTypeName(dep.type)} · 间隔 ${formatMinDuration(dep.lag ?? 0, { signed: true })}${dep.active === false ? ' · 停用' : ''}` : '无'

export default function ScheduleImpactPanel({ readOnly, isMinute, onClose, onLocate }: {
  readOnly: boolean; isMinute: boolean; onClose: () => void; onLocate: (id: string) => void
}) {
  const dispatch = useAppDispatch()
  const history = useAppSelector(s => s.draft)
  const { tasks, dependencies, viewSnapshot } = useAppSelector(s => s.tasks)
  const project = useAppSelector(s => s.project.currentProject)
  const lines = useAppSelector(s => s.projectLines.lines)
  const [scope, setScope] = useState<'latest' | 'pending'>('latest')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ImpactCategory | ''>('')
  const [page, setPage] = useState(0)
  const [depPage, setDepPage] = useState(0)
  const latest = history.past.at(-1)
  const current = useMemo<DraftSnapshot>(() => ({ tasks, dependencies, lines, descriptions: EMPTY_DESCRIPTIONS,
    statusDate: project?.status_date ?? null, planningStatus: project?.planning_status,
    customFields: project?.custom_fields, planBaseline: project?.plan_baseline,
  }), [tasks, dependencies, lines, project?.status_date, project?.planning_status, project?.custom_fields, project?.plan_baseline])
  const impact = useMemo(() => {
    if (viewSnapshot) return null
    if (scope === 'latest') return latest ? buildScheduleImpact(latest.before, latest.after, latest) : null
    return history.baseline ? buildScheduleImpact(history.baseline, current, { label: '全部待保存', cumulative: true,
      directTaskIds: [...new Set(history.past.flatMap(step => step.directTaskIds ?? []))],
    }) : null
  }, [scope, latest, history.baseline, history.past, current, viewSnapshot])
  const visible = useMemo(() => impact?.tasks.filter(t => (!category || t.category === category)
    && t.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [], [impact, query, category])
  useEffect(() => { setPage(0); setDepPage(0) }, [impact, query, category])
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1)
  const activePage = Math.min(page, lastPage)
  const depLastPage = Math.max(0, Math.ceil((impact?.dependencies.length ?? 0) / PAGE_SIZE) - 1)
  const date = (value?: string | null) => {
    const normalized = toDateTimeStr(value)
    return normalized ? (isMinute ? normalized.slice(0, 16).replace('T', ' ') : normalized.slice(0, 10)) : '—'
  }
  const hasImpact = !!impact && !!(impact.tasks.length || impact.dependencies.length || impact.projectChanges.length)
  return <aside id="schedule-impact-panel" aria-label="排程影响预览" className="flex w-[420px] max-w-[48vw] min-w-[280px] shrink-0 flex-col border-l border-gray-200 bg-white text-xs"
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
    <div className="border-b p-3 space-y-3">
      <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-gray-900">排程影响预览</h2>
        <button type="button" aria-label="关闭影响预览" className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100" onClick={onClose}>✕</button></div>
      <div className="flex rounded bg-gray-100 p-0.5" role="group" aria-label="影响范围">
        {(['latest', 'pending'] as const).map(value => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}
          className={`flex-1 rounded px-2 py-1.5 ${scope === value ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>{value === 'latest' ? '最近一步' : '全部待保存'}</button>)}
      </div>
      <p className="leading-5 text-gray-500">{scope === 'latest' ? '查看最近一步操作及其联动结果。' : '日期与上次保存比较，已抵消的修改不再列出。'} 修改已应用到本地草稿，点击工具栏“保存”或“确认变更”后写入后台。</p>
      {history.saving ? <p role="status" className="text-blue-700">正在保存；期间的新修改仍会保留为待保存草稿。</p>
        : history.uncertain ? <p role="status" className="text-amber-800">上次保存结果待核对，请重试保存。当前预览不能代表后台状态。</p> : null}
      {!viewSnapshot && <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium" title={latest?.label}>{scope === 'latest' ? latest?.label ?? '暂无待保存操作' : '累计待保存影响'}</span>
        <button type="button" disabled={readOnly || !latest || history.saving || history.uncertain} onClick={() => dispatch(undoDraft())}
          title={latest ? `撤销“${latest.label}”及其全部联动修改` : '没有可撤销的操作'}
          className="shrink-0 rounded border px-2 py-1 text-blue-700 disabled:opacity-40">撤销最近一步</button>
      </div>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
      {viewSnapshot ? <p className="py-6 text-center text-gray-500">返回当前计划后查看草稿影响。</p>
        : !hasImpact ? <p role="status" className="py-6 text-center text-gray-500">{scope === 'latest' ? '暂无待保存操作。编辑任务后可在此查看影响。' : '当前草稿与已保存计划一致。'}</p>
        : <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-600" aria-label="影响统计">
            <span>{impact.tasks.length} 个任务</span><span>{impact.dependencies.length} 条依赖</span>
            {Object.entries(categories).map(([key, label]) => {
              const count = impact.tasks.filter(t => t.category === key).length
              return count ? <span key={key}>{label} {count}</span> : null
            })}
          </div>
          {impact.projectChanges.length > 0 && <p className="rounded bg-blue-50 p-2 text-blue-800">项目变化：{impact.projectChanges.join('、')}</p>}
          {impact.tasks.length > 0 && <>
            <div className="flex gap-2">
              <input aria-label="筛选影响任务" placeholder="查找受影响任务" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1.5" />
              <select aria-label="影响类型" value={category} onChange={e => setCategory(e.target.value as ImpactCategory | '')} className="rounded border px-1">
                <option value="">全部类型</option>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </div>
            {!visible.length && <p className="text-gray-500">没有匹配的任务。</p>}
            {visible.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map(task => <article key={task.id} data-impact-task={task.id} className="rounded-md border border-gray-200 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><h3 className="break-words font-medium text-gray-900">{task.name}</h3>
                  <span className={`mt-1 inline-block rounded px-1.5 py-0.5 ${task.category === 'cascade' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{task.kind === 'deleted' ? '删除 · ' : task.kind === 'added' ? '新增 · ' : ''}{categories[task.category]}</span></div>
                {task.after && <button type="button" className="shrink-0 text-blue-600 hover:underline" aria-label={`定位 ${task.name}`} onClick={() => onLocate(task.id)}>定位</button>}
              </div>
              <table className="w-full text-left text-[11px] tabular-nums"><thead className="text-gray-400"><tr><th className="font-normal">日期</th><th className="font-normal">之前</th><th className="font-normal">之后</th></tr></thead>
                <tbody><tr><th className="font-normal text-gray-500">开始</th><td>{date(task.before?.start_date)}</td><td>{date(task.after?.start_date)}</td></tr>
                  <tr><th className="font-normal text-gray-500">完成</th><td>{date(task.before?.end_date)}</td><td>{date(task.after?.end_date)}</td></tr>
                  <tr><th className="font-normal text-gray-500">工期</th><td>{task.before?.duration == null ? '—' : formatMinDuration(task.before.duration)}</td><td>{task.after?.duration == null ? '—' : formatMinDuration(task.after.duration)}</td></tr></tbody>
              </table>
              <p className="text-gray-600">开始：{deltaLabel(task.startDelta)}；完成：{deltaLabel(task.finishDelta)}{task.durationDelta ? `；工期${task.durationDelta < 0 ? '缩短' : '增加'} ${formatMinDuration(task.durationDelta)}` : ''}</p>
              <p className="leading-5 text-gray-700">{task.reason}</p>
              <p className="text-gray-400">变化字段：{task.fields.join('、') || '任务属性'}</p>
            </article>)}
            {lastPage > 0 && <div className="flex items-center justify-between gap-2" aria-label="影响任务分页">
              <button disabled={activePage === 0} onClick={() => setPage(activePage - 1)} className="text-blue-600 disabled:opacity-40">上一页</button>
              <span>{activePage + 1} / {lastPage + 1} 页 · {visible.length} 个任务</span>
              <button disabled={activePage === lastPage} onClick={() => setPage(activePage + 1)} className="text-blue-600 disabled:opacity-40">下一页</button>
            </div>}
          </>}
          {impact.dependencies.length > 0 && <details className="rounded border p-2">
            <summary className="cursor-pointer text-gray-600">依赖变化（{impact.dependencies.length}）</summary>
            <ul className="mt-2 space-y-2">{impact.dependencies.slice(depPage * PAGE_SIZE, (depPage + 1) * PAGE_SIZE).map(dep => <li key={dep.id} className="break-words border-t pt-2">
              <p>{dep.fromName} → {dep.toName}</p><p className="mt-1 text-gray-500">{depLabel(dep.before)} → {depLabel(dep.after)}</p>
            </li>)}</ul>
            {depLastPage > 0 && <div className="mt-2 flex justify-between">
              <button disabled={!depPage} onClick={() => setDepPage(n => n - 1)} className="text-blue-600 disabled:opacity-40">上一页依赖</button>
              <span>{depPage + 1} / {depLastPage + 1}</span>
              <button disabled={depPage >= depLastPage} onClick={() => setDepPage(n => n + 1)} className="text-blue-600 disabled:opacity-40">下一页依赖</button>
            </div>}
          </details>}
        </>}
    </div>
  </aside>
}
