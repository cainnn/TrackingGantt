'use client'

import { useEffect, useRef, useState } from 'react'
import { formatDateDisplay, parseDateInput } from '@/lib/clientDateInput'

export default function DateCellEditor({ value, defaultValue = '', onChange, onCommit, onCancel, includeTime = false, allowEmpty = false, label }: {
  value?: string; defaultValue?: string; onChange?: (value: string) => void
  onCommit: (value: string) => void; onCancel: () => void
  includeTime?: boolean; allowEmpty?: boolean; label: string
}) {
  const [draft, setDraft] = useState(formatDateDisplay(value ?? defaultValue, includeTime))
  const [invalid, setInvalid] = useState(false)
  const root = useRef<HTMLDivElement>(null), text = useRef<HTMLInputElement>(null)
  const committed = useRef(false)
  const ownValue = useRef<string | undefined>(undefined)
  const initialYear = Number((value ?? defaultValue).slice(0, 4))
  const referenceDate = useRef(value ?? defaultValue)
  const referenceYear = useRef(Number.isInteger(initialYear) && initialYear >= 100 ? initialYear : new Date().getFullYear())
  useEffect(() => { text.current?.focus(); text.current?.select() }, [])
  useEffect(() => {
    if (value !== undefined && value !== ownValue.current) setDraft(formatDateDisplay(value, includeTime))
  }, [value, includeTime])
  const change = (next: string) => {
    ownValue.current = next
    committed.current = false; setInvalid(false); setDraft(next.replace('T', ' ')); onChange?.(next)
  }
  const commit = () => {
    if (committed.current) return
    const parsed = !draft.trim() && allowEmpty ? '' : parseDateInput(draft, includeTime, referenceYear.current, referenceDate.current)
    if (parsed == null) { setInvalid(true); return }
    committed.current = true; onCommit(parsed)
  }
  return <div ref={root} data-date-editor className="relative w-full min-w-0"
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) commit() }}>
    <input ref={text} type="text" aria-label={label} aria-invalid={invalid}
      placeholder={includeTime ? 'YY-MM-DD HH:mm' : 'YY-MM-DD'} autoComplete="off"
      title={invalid ? '日期无效，请输入年-月-日，例如 26-11-04' : parseDateInput(draft, includeTime, referenceYear.current, referenceDate.current) ?? 'YY-MM-DD（支持四位年份）'}
      className={`h-6 w-full min-w-0 rounded border px-1 text-[11px] outline-none ${invalid ? 'border-red-500 bg-red-50' : 'border-blue-400 bg-white'}`}
      value={draft} onChange={event => change(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape') { committed.current = true; onCancel() }
      }} />
  </div>
}
