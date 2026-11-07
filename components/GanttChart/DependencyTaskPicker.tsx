'use client'

import { useId, useMemo, useState } from 'react'
import type { Task } from '@/types'
import { buildDependencyTaskLookup, findDependencyTasks, type DependencyTaskOption } from '@/lib/dependencyTaskLookup'

export default function DependencyTaskPicker({ tasks, numbers, taskId, selectedIds, label, mode = 'add', readOnly = false, onPick, onCancel }: {
  tasks: Task[]; numbers: Map<string, number>; taskId: string; selectedIds: string[]; label: string
  mode?: 'add' | 'toggle'; readOnly?: boolean
  onPick: (id: string) => string | void
  onCancel?: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const listId = useId()
  const index = useMemo(() => buildDependencyTaskLookup(tasks, numbers), [tasks, numbers])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const { options, more } = useMemo(() => findDependencyTasks(index, query, taskId, selected), [index, query, taskId, selected])
  const current = options[Math.min(active, options.length - 1)]
  const pick = (option: DependencyTaskOption) => {
    if (readOnly) return
    if (mode === 'add' && selected.has(option.id)) { setError('已经关联此任务，请输入其他编号'); return }
    const message = onPick(option.id)
    if (message) setError(message)
    else { setQuery(''); setActive(0); setError('') }
  }
  return <div className="text-sm" data-dependency-picker>
    <label htmlFor={`${listId}-input`} className="mb-1.5 block text-xs font-medium text-gray-600">{label}</label>
    <input id={`${listId}-input`} autoFocus role="combobox" aria-label={label} aria-autocomplete="list"
      aria-controls={listId} aria-expanded={options.length > 0} aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
      placeholder="输入列表编号，或搜索任务名称" value={query}
      onChange={e => { setQuery(e.target.value); setActive(0); setError('') }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') { e.preventDefault(); if (onCancel) onCancel(); else { setQuery(''); setError('') }; return }
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
          e.preventDefault(); const next = Math.max(0, Math.min(options.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
          setActive(next); document.getElementById(`${listId}-${options[next]?.id}`)?.scrollIntoView({ block: 'nearest' }); return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!query.trim()) { setError('请输入任务编号或名称'); return }
          if (current) pick(current)
          else setError('未找到可关联任务，请核对列表“编号”；不能关联自身或摘要任务')
        }
      }} className="h-9 w-full rounded border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500" />
    <p className="my-1.5 text-[11px] leading-4 text-gray-400">编号与左侧列表一致。{mode === 'toggle' ? '回车添加；已关联的任务可再次回车取消。' : '输入编号后按回车添加。'}</p>
    {error && <p role="alert" className="mb-2 text-xs text-red-600">{error}</p>}
    <div id={listId} role="listbox" aria-multiselectable="true" aria-label={`${label}匹配结果`} className="max-h-44 overflow-y-auto rounded border border-gray-100">
      {options.map((option, i) => <button key={option.id} id={`${listId}-${option.id}`} type="button" role="option"
        aria-selected={selected.has(option.id)} aria-disabled={readOnly || (mode === 'add' && selected.has(option.id))}
        tabIndex={-1} onMouseDown={e => e.preventDefault()} onClick={() => pick(option)}
        className={`flex w-full items-center gap-2 px-2 py-2 text-left text-xs ${i === active ? 'bg-blue-50' : 'hover:bg-gray-50'} ${readOnly ? 'text-gray-400' : 'text-gray-700'}`}>
        <span className="w-9 shrink-0 font-mono text-gray-500">#{option.number}</span>
        <span className="min-w-0 flex-1 truncate" title={option.name}>{option.name}</span>
        {selected.has(option.id) && <span className="shrink-0 text-blue-600">已关联</span>}
      </button>)}
      {!options.length && <div className="px-2 py-3 text-center text-xs text-gray-400">无匹配任务</div>}
    </div>
    {more && <p className="mt-1.5 text-[11px] text-gray-400">仅显示前 30 项，输入编号或名称可快速定位。</p>}
  </div>
}
