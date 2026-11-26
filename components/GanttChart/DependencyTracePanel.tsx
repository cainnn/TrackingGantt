'use client'

import { useEffect, useMemo, useState } from 'react'
import { DEPENDENCY_TYPES, TRACE_MODES, type DependencyGraph, type TraceLink, type TraceLinkStatus, type TraceMode, type TracePath } from '@/lib/dependencyTrace'
import { CONSTRAINT_TYPES } from './constants'

const STATUS_LABELS: Record<TraceLinkStatus, string> = {
  driving: '驱动', slack: '有余量', conflict: '排程冲突', inactive: '已停用', missing: '任务缺失',
  invalid: '无法计算', manual: '手动固定', fixed: '限制固定', summary: '摘要边界', cycle: '循环依赖',
}
const control = 'h-8 rounded border border-gray-300 bg-white px-2 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40'

function TaskSearch({ graph, label, exclude, onPick }: { graph: DependencyGraph; label: string; exclude?: string; onPick: (id: string) => void }) {
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [index, setIndex] = useState(0)
  const options = useMemo(() => {
    const q = query.trim().toLowerCase(), exact = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null
    return [...graph.tasks.values()].filter(t => t.id !== exclude && (exact != null ? graph.numbers.get(t.id) === exact : !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase() === q))
      .sort((a, b) => (graph.numbers.get(a.id) ?? Infinity) - (graph.numbers.get(b.id) ?? Infinity)).slice(0, 30)
  }, [graph, query, exclude])
  const pick = (id: string) => { onPick(id); setQuery(''); setOpen(false); setIndex(0) }
  return <div className="relative w-60 max-w-full" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
    <input aria-label={label} role="combobox" aria-expanded={open} aria-controls={`${label}-options`} aria-autocomplete="list"
      placeholder={label} value={query} onFocus={() => setOpen(true)}
      onChange={e => { setQuery(e.target.value); setIndex(0); setOpen(true) }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') { setOpen(false); e.stopPropagation() }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setIndex(i => Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))) }
        if (e.key === 'Enter' && open && options[index]) { e.preventDefault(); pick(options[index].id) }
      }} className="h-8 w-full rounded border border-gray-300 bg-white px-2 text-xs" />
    {open && <div id={`${label}-options`} role="listbox" aria-label={`${label}匹配结果`} className="absolute bottom-full z-50 mb-1 max-h-48 w-80 max-w-[85vw] overflow-auto rounded border border-gray-200 bg-white p-1 shadow-lg">
      {options.map((task, i) => <button key={task.id} type="button" role="option" aria-selected={i === index}
        onMouseDown={e => e.preventDefault()} onClick={() => pick(task.id)}
        className={`block w-full truncate rounded px-2 py-2 text-left text-xs ${i === index ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50'}`}>
        #{graph.numbers.get(task.id) ?? '—'} {task.name}
      </button>)}
      {!options.length && <p className="p-2 text-xs text-gray-500">未找到任务</p>}
      {options.length === 30 && <p className="p-2 text-xs text-gray-400">输入编号或名称缩小范围</p>}
    </div>}
  </div>
}

export default function DependencyTracePanel({ graph, focusId, mode, path, targetId, tolerance, onlyPath, isMinute, sourceLabel,
  onModeChange, onTargetChange, onToleranceChange, onOnlyPathChange, onLocate, onFit, onClear, onClose }: {
  graph: DependencyGraph; focusId: string; mode: TraceMode | 'direct'; path: TracePath | null; targetId: string
  tolerance: number; onlyPath: boolean; isMinute: boolean; sourceLabel: string
  onModeChange: (mode: TraceMode | 'direct') => void; onTargetChange: (id: string) => void
  onToleranceChange: (value: number) => void; onOnlyPathChange: (value: boolean) => void
  onLocate: (id: string) => void; onFit: () => void; onClear: () => void; onClose: () => void
}) {
  const focus = graph.tasks.get(focusId), target = graph.tasks.get(targetId)
  const predecessors = useMemo(() => {
    if (mode !== 'upstream' || !path) return []
    const direct = new Set((graph.incoming.get(focusId) ?? []).filter(link => link.traversable).map(link => link.dependency.from_task_id))
    return [...path.taskIds].filter(id => id !== focusId).sort((a, b) => (graph.numbers.get(a) ?? Infinity) - (graph.numbers.get(b) ?? Infinity))
      .flatMap(id => { const task = graph.tasks.get(id); return task ? [{ task, direct: direct.has(id) }] : [] })
  }, [graph, focusId, mode, path])
  const [history, setHistory] = useState<{ ids: string[]; index: number }>({ ids: [], index: -1 })
  const [large, setLarge] = useState(false)
  useEffect(() => {
    if (!focusId) return
    setHistory(prev => prev.ids[prev.index] === focusId ? prev : { ids: [...prev.ids.slice(0, prev.index + 1), focusId], index: prev.index + 1 })
  }, [focusId])
  const navigate = (index: number) => { setHistory(h => ({ ...h, index })); onLocate(history.ids[index]) }
  const date = (value: string | null) => value?.replace('T', ' ').slice(0, isMinute ? 16 : 10) || '—'
  const duration = (value: number | null) => value == null ? '—' : isMinute ? `${value} 分钟` : `${Number((value / 1440).toFixed(3))} 天`
  const table = (links: TraceLink[], backwards: boolean) => <section className="min-w-0 rounded-lg border border-gray-200 bg-white">
    <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">{backwards ? '前置任务' : '后续任务'} <span className="font-normal text-gray-500">({links.length})</span></h3>
    <div className="max-h-56 overflow-auto">
      <table className="w-full whitespace-nowrap text-left text-xs" aria-label={backwards ? '前置任务列表' : '后续任务列表'}>
        <thead className="sticky top-0 bg-white text-gray-500"><tr>{['任务', '关系', '间隔', '驱动时差', '开始', '结束', '状态'].map(label => <th key={label} className="border-b px-2 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{links.map(link => {
          const task = backwards ? link.from : link.to
          return <tr key={link.dependency.id} data-trace-dependency={link.dependency.id} data-trace-status={link.status}
            className={`border-b border-gray-100 ${link.status === 'inactive' ? 'text-gray-400' : 'text-gray-700'} ${link.status === 'driving' ? 'bg-violet-50/70' : ''}`}>
            <td className="px-2 py-2">{task ? <button type="button" title={`跟踪 ${task.name}；任务 ID：${task.id}`} onClick={() => onLocate(task.id)}
              className="flex max-w-64 items-center gap-2 text-left text-blue-700 hover:underline"><span className="font-mono text-gray-400">#{graph.numbers.get(task.id) ?? '—'}</span><span className="truncate">{task.name}</span><span aria-hidden="true">→</span></button> : '已删除或不存在'}</td>
            <td className="px-2 py-2">{DEPENDENCY_TYPES[link.dependency.type ?? 2] ?? '—'}</td>
            <td className="px-2 py-2">{duration(link.dependency.lag ?? 0)}</td>
            <td className="px-2 py-2 font-mono" title={link.reason}>{duration(link.slackMinutes)}</td>
            <td className="px-2 py-2">{date(task?.start_date ?? null)}</td><td className="px-2 py-2">{date(task?.end_date ?? null)}</td>
            <td className="px-2 py-2" title={link.reason}><span className={link.status === 'driving' ? 'font-semibold text-violet-700' : ['conflict', 'cycle', 'invalid', 'missing'].includes(link.status) ? 'text-amber-700' : ''}>{STATUS_LABELS[link.status]}</span></td>
          </tr>
        })}</tbody>
      </table>
      {!links.length && <p className="px-3 py-5 text-center text-xs text-gray-400">没有{backwards ? '前置' : '后续'}依赖</p>}
    </div>
  </section>

  return <section id="dependency-trace-panel" aria-label="依赖查询跟踪" className={`flex shrink-0 flex-col border-t border-gray-300 bg-slate-50 ${large ? 'h-[55vh]' : 'h-[340px] max-h-[48vh]'}`}>
    <header className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
      <h2 className="mr-1 text-sm font-semibold text-gray-900">依赖查询跟踪</h2>
      <span className="text-xs text-gray-400">{sourceLabel}</span>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" className={control} aria-label="跟踪后退" disabled={history.index <= 0 || !graph.tasks.has(history.ids[history.index - 1])} onClick={() => navigate(history.index - 1)}>← 后退</button>
        <button type="button" className={control} aria-label="跟踪前进" disabled={history.index >= history.ids.length - 1 || !graph.tasks.has(history.ids[history.index + 1])} onClick={() => navigate(history.index + 1)}>前进 →</button>
        <button type="button" className={control} onClick={() => setLarge(v => !v)} aria-label={large ? '缩小跟踪面板' : '展开跟踪面板'}>{large ? '缩小' : '展开'}</button>
        <button type="button" className={control} onClick={onClose} aria-label="关闭依赖跟踪">关闭</button>
      </div>
    </header>
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2">
      <TaskSearch graph={graph} label="按编号或名称查找任务" onPick={onLocate} />
      <select aria-label="路径模式" value={mode} onChange={e => onModeChange(e.target.value as TraceMode | 'direct')} className={control}>
        <option value="direct">直接前置／后续</option>
        {Object.entries(TRACE_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {['driving', 'driven', 'both'].includes(mode) && <label className="flex items-center gap-1 text-xs text-gray-600">累计驱动时差 ≤
        <input type="number" aria-label="驱动时差上限" min={0} step={isMinute ? 1 : 0.25} value={tolerance} onChange={e => {
          const value = e.currentTarget.valueAsNumber
          if (Number.isFinite(value) && value >= 0) onToleranceChange(value)
        }} className="h-8 w-16 rounded border border-gray-300 bg-white px-2" />{isMinute ? '分钟' : '天'}</label>}
      {mode === 'connecting' && <><span className="text-xs text-gray-500">→</span><TaskSearch graph={graph} label="查找连接终点" exclude={focusId} onPick={onTargetChange} />
        {target && <span className="max-w-56 truncate text-xs text-blue-700" title={target.name}>终点：#{graph.numbers.get(target.id)} {target.name}</span>}</>}
      {mode !== 'direct' && <><label className="flex items-center gap-1 text-xs text-gray-700"><input type="checkbox" checked={onlyPath} onChange={e => onOnlyPathChange(e.target.checked)} />仅显示路径</label>
        <button type="button" className={control} disabled={!path?.taskIds.size} onClick={onFit}>适配路径</button>
        <button type="button" className={control} onClick={onClear}>清除路径</button></>}
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3">
      {!focus ? <p className="py-6 text-center text-sm text-gray-500">在甘特图中选择一个任务，或输入编号／名称开始跟踪。</p> : <>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-600" data-trace-focus={focus.id}>
          <strong className="max-w-full truncate text-sm text-gray-900" title={focus.name}>#{graph.numbers.get(focus.id) ?? '—'} {focus.name}</strong>
          <span>{date(focus.start_date)} → {date(focus.end_date)}</span><span>工期 {duration(focus.duration)}</span>
          <span>{focus.auto_schedule === false ? '手动排程' : '自动排程'}</span>
          {focus.constraint_type && !['none', 'asap'].includes(focus.constraint_type) && <span>{CONSTRAINT_TYPES.find(c => c.value === focus.constraint_type)?.label ?? focus.constraint_type} {date(focus.constraint_date ?? null)}</span>}
        </div>
        {path && <div className="space-y-1 text-xs" role="status" data-trace-result>
          <p className="text-violet-800">{TRACE_MODES[mode as TraceMode]} · {path.taskIds.size} 个任务 · {path.dependencyIds.size} 条关系{onlyPath ? '；临时只显示路径及其父级，清除后恢复原筛选。' : '；紫色为路径，深紫色为当前任务。'}</p>
          {!path.found && !path.warnings.length && <p className="text-gray-500">当前方向没有满足条件的依赖，路径仅包含当前任务。</p>}
          {path.warnings.map(w => <p key={w} className="text-amber-700">{w}</p>)}
          {mode !== 'upstream' && !!path.dependencyIds.size && <details><summary className="cursor-pointer py-1 text-gray-600">查看路径任务</summary><div className="flex flex-wrap gap-1 py-1">{[...path.taskIds].sort((a, b) => (graph.numbers.get(a) ?? 0) - (graph.numbers.get(b) ?? 0)).map(id => <button key={id} className="max-w-64 truncate rounded border border-violet-200 bg-white px-2 py-1 text-violet-700" onClick={() => onLocate(id)}>#{graph.numbers.get(id)} {graph.tasks.get(id)?.name}</button>)}</div></details>}
        </div>}
        {mode === 'upstream' && path && <section className="rounded-lg border border-violet-200 bg-white" aria-label="所有前置任务">
          <h3 className="border-b border-violet-100 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-900">所有前置任务（共 {predecessors.length} 个）</h3>
          <p className="px-3 py-2 text-xs text-gray-500">包含所有层级的有效前置任务；每个任务只列一次，不包含当前任务及仅用于展示层级的父任务。</p>
          <div className="max-h-64 overflow-auto"><table aria-label="所有前置任务列表" className="w-full whitespace-nowrap text-left text-xs">
            <thead className="sticky top-0 bg-white text-gray-500"><tr>{['任务', '与当前任务的关系', '开始', '结束'].map(label => <th key={label} className="border-b px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody>{predecessors.map(({ task, direct }) => <tr key={task.id} data-trace-predecessor={task.id} className="border-b border-gray-100 text-gray-700">
              <td className="px-3 py-2"><button type="button" onClick={() => onLocate(task.id)} title={task.name} className="flex max-w-md items-center gap-2 text-blue-700 hover:underline"><span className="font-mono text-gray-400">#{graph.numbers.get(task.id) ?? '—'}</span><span className="truncate">{task.name}</span></button></td>
              <td className="px-3 py-2">{direct ? '直接前置' : '间接前置'}</td><td className="px-3 py-2">{date(task.start_date)}</td><td className="px-3 py-2">{date(task.end_date)}</td>
            </tr>)}</tbody>
          </table></div>
          {!predecessors.length && <p className="px-3 py-5 text-center text-xs text-gray-500">当前任务没有有效前置任务。</p>}
        </section>}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{table(graph.incoming.get(focus.id) ?? [], true)}{table(graph.outgoing.get(focus.id) ?? [], false)}</div>
        <p className="text-[11px] leading-5 text-gray-500">点击任务名称逐级跟踪。驱动时差按关系端点和间隔计算，0 表示紧邻驱动，负数表示日期冲突；沿链累计时差不超过上限时纳入路径。按项目连续自然日／分钟分析，读取当前显示的计划。</p>
      </>}
    </div>
  </section>
}
