'use client'

import { useEffect, useRef, useState } from 'react'

export interface ToolbarAction {
  label: string
  onSelect: () => void
  disabled?: boolean
  shortcut?: string
  danger?: boolean
  divider?: boolean
}

export default function ToolbarActionMenu({ label, actions }: { label: string; actions: ToolbarAction[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div ref={root} className="relative">
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}
      className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded border border-gray-300 bg-white px-2.5 text-[13px] text-gray-700 hover:bg-gray-50">
      {label}<span aria-hidden="true" className="text-gray-400">▾</span>
    </button>
    {open && <div ref={menu} role="menu" aria-label={label}
      className="absolute left-0 top-full z-50 mt-1 w-64 max-w-[calc(100vw-24px)] rounded-lg border border-gray-200 bg-white py-1.5 shadow-xl"
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); return }
        if (e.key === 'Tab') { setOpen(false); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}>
      {actions.map(action => <div key={action.label} className={action.divider ? 'mt-1 border-t border-gray-100 pt-1' : ''}>
        <button type="button" role="menuitem" tabIndex={-1} disabled={action.disabled}
          onClick={() => { setOpen(false); trigger.current?.focus(); action.onSelect() }}
          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] outline-none hover:bg-blue-50 focus:bg-blue-50 disabled:text-gray-300 ${action.danger ? 'text-red-600' : 'text-gray-700'}`}>
          <span>{action.label}</span>{action.shortcut && <span className="text-[11px] text-gray-400">{action.shortcut}</span>}
        </button>
      </div>)}
    </div>}
  </div>
}
