'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isCalendarDate, resolveTaskDateFilter, TASK_DATE_FIELD_LABELS, type TaskDateField, type TaskDateFilter } from '@/lib/taskDateFilter'

export default function TaskDateFilterControls({ value, today, onChange }: {
  value: TaskDateFilter | null
  today: string
  onChange: (value: TaskDateFilter | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<TaskDateField>('end')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 340 })
  const range = resolveTaskDateFilter(value, today)
  const error = !from || !to ? '请选择起始日期和截止日期'
    : !isCalendarDate(from) || !isCalendarDate(to) ? '请输入有效日期'
    : from > to ? '起始日期不能晚于截止日期' : ''
  const close = () => { setOpen(false); trigger.current?.focus() }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(340, window.innerWidth - 24)
      setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: rect.bottom + 6, width })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close() }
    }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  const buttonClass = (active: boolean) => `h-8 whitespace-nowrap rounded border px-2.5 text-[13px] ${active ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`
  return <div ref={root} role="group" aria-label="任务日期筛选" className="flex flex-wrap items-center gap-1.5">
    <button type="button" aria-pressed={value?.kind === 'week'} title="筛选从今天起 7 天内结束的任务（含今天）"
      className={buttonClass(value?.kind === 'week')} onClick={() => { setOpen(false); onChange(value?.kind === 'week' ? null : { kind: 'week' }) }}>近一周</button>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open}
      className={buttonClass(open || value?.kind === 'custom')} onClick={() => {
        if (open) { close(); return }
        const initial = range ?? resolveTaskDateFilter({ kind: 'week' }, today)!
        setField(initial.field); setFrom(initial.from); setTo(initial.to); setOpen(true)
      }}>自定义日期</button>
    {range && <>
      <span data-date-filter-summary className="text-xs text-blue-700">{TASK_DATE_FIELD_LABELS[range.field]}：{range.from} 至 {range.to}</span>
      <button type="button" className="h-8 whitespace-nowrap px-1 text-xs text-gray-500 hover:text-blue-600" onClick={() => { setOpen(false); onChange(null) }}>清除日期筛选</button>
    </>}
    {open && <div role="dialog" aria-label="自定义日期筛选" style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }}
      className="fixed z-50 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-xl"
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close() } }}>
      <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-gray-900">自定义日期筛选</h2>
        <button type="button" aria-label="关闭日期筛选" onClick={close} className="px-1 text-xl leading-none text-gray-400 hover:text-gray-700">×</button></div>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (error) return; onChange({ kind: 'custom', field, from, to }); close() }}>
        <label className="block text-xs text-gray-600">筛选依据
          <select autoFocus aria-label="筛选依据" value={field} onChange={event => setField(event.target.value as TaskDateField)} className="mt-1 h-9 w-full rounded border border-gray-300 bg-white px-2 text-sm">
            {Object.entries(TASK_DATE_FIELD_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="min-w-0 text-xs text-gray-600">起始日期
            <input type="date" aria-label="筛选起始日期" value={from} onChange={event => setFrom(event.target.value)} required className="mt-1 h-9 w-full min-w-0 rounded border border-gray-300 px-2 text-sm" />
          </label>
          <label className="min-w-0 text-xs text-gray-600">截止日期
            <input type="date" aria-label="筛选截止日期" value={to} onChange={event => setTo(event.target.value)} required className="mt-1 h-9 w-full min-w-0 rounded border border-gray-300 px-2 text-sm" />
          </label>
        </div>
        <p className="text-xs leading-5 text-gray-500">包含首尾两天。{field === 'either' ? '开始或结束日期任一落在范围内即匹配。' : `按任务${TASK_DATE_FIELD_LABELS[field]}匹配。`}</p>
        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-1"><button type="button" onClick={close} className="px-2 text-gray-600">取消</button>
          <button type="submit" disabled={!!error} className="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">应用筛选</button></div>
      </form>
    </div>}
  </div>
}
