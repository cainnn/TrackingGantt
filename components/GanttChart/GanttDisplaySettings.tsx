'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { OPTIONAL_COL_META, INDICATOR_META, type OptionalCol, type IndicatorsConfig } from './GanttChart'

export default function GanttDisplaySettings({ visibleCols, onVisibleColsChange, indicators, onIndicatorsChange, onExpandAll, onCollapseAll, viewControls }: {
  visibleCols?: OptionalCol[]
  onVisibleColsChange?: (cols: OptionalCol[]) => void
  indicators?: IndicatorsConfig
  onIndicatorsChange?: (value: IndicatorsConfig) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  viewControls?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'content' | 'layouts'>('content')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 360 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(360, window.innerWidth - 24)
      setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: rect.bottom + 6, width })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div ref={root} className="relative">
    <button ref={trigger} type="button" aria-label="显示设置" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className={`inline-flex h-8 items-center gap-2 whitespace-nowrap rounded border px-2.5 text-[13px] ${open ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>
      显示设置<span aria-hidden="true" className="text-gray-400">▾</span>
    </button>
    {open && <div role="dialog" aria-label="显示设置"
      style={position} className="fixed z-50 rounded-xl border border-gray-200 bg-white shadow-xl"
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus() }
      }}>
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">显示设置</h2>
        <button type="button" aria-label="关闭显示设置" onClick={() => { setOpen(false); trigger.current?.focus() }} className="px-1 text-xl leading-none text-gray-400 hover:text-gray-700">×</button>
      </div>
      <div className="flex gap-5 border-b border-gray-100 px-4 text-sm" role="tablist" aria-label="显示设置分类">
        {([['content', '显示内容'], ...(viewControls ? [['layouts', '常用布局']] : [])] as [typeof tab, string][]).map(([key, label]) => <button
          key={key} type="button" role="tab" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={e => {
            if (viewControls && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
              e.preventDefault(); const next = tab === 'content' ? 'layouts' : 'content'; setTab(next)
              const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
              buttons?.[next === 'content' ? 0 : 1]?.focus()
            }
          }} className={`border-b-2 py-2.5 ${tab === key ? 'border-blue-500 font-medium text-blue-600' : 'border-transparent text-gray-500'}`}>
          {label}
        </button>)}
      </div>
      <div style={{ maxHeight: `min(520px, calc(100dvh - ${position.top + 110}px))` }} className="overflow-y-auto p-4 text-sm">
        <div role="tabpanel" aria-label="显示内容" hidden={tab !== 'content'} className="space-y-4">
          <div className="flex gap-2">
            <button type="button" title="全部展开" onClick={onExpandAll} className="flex-1 rounded border border-gray-200 px-2 py-1.5 hover:bg-gray-50">展开全部任务</button>
            <button type="button" title="全部折叠" onClick={onCollapseAll} className="flex-1 rounded border border-gray-200 px-2 py-1.5 hover:bg-gray-50">折叠全部任务</button>
          </div>
          {visibleCols && onVisibleColsChange && <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="font-medium text-gray-800">表格显示列</h3>
              <div className="flex gap-2 text-xs text-blue-600">
                <button type="button" onClick={() => onVisibleColsChange(OPTIONAL_COL_META.map(c => c.key))}>全选</button>
                <button type="button" onClick={() => onVisibleColsChange([])}>全不选</button>
                <button type="button" onClick={() => onVisibleColsChange(OPTIONAL_COL_META.filter(c => !visibleCols.includes(c.key)).map(c => c.key))}>反选</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {OPTIONAL_COL_META.map(col => <label key={col.key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50">
                <input type="checkbox" className="accent-blue-600" checked={visibleCols.includes(col.key)} onChange={() => onVisibleColsChange(
                  visibleCols.includes(col.key) ? visibleCols.filter(k => k !== col.key) : [...visibleCols, col.key]
                )} />{col.label}
              </label>)}
            </div>
          </section>}
          {indicators && onIndicatorsChange && <section className="border-t border-gray-100 pt-3">
            <h3 className="mb-1 font-medium text-gray-800">甘特图标记</h3>
            {INDICATOR_META.map(item => <label key={item.key} className="flex cursor-pointer items-center gap-2 py-1.5 text-[13px] text-gray-600">
              <input type="checkbox" className="accent-blue-600" checked={!!indicators[item.key]} onChange={() => onIndicatorsChange({ ...indicators, [item.key]: !indicators[item.key] })} />{item.label}
            </label>)}
          </section>}
        </div>
        <div role="tabpanel" aria-label="常用布局" hidden={tab !== 'layouts'}>{viewControls}</div>
      </div>
    </div>}
  </div>
}
