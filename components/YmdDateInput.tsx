'use client'

import React, { useEffect, useRef, useState } from 'react'

/**
 * 年-月-日（可选带 时:分）输入。
 * - 显示：固定 24 小时 'YYYY-MM-DD[ HH:mm:00]'，不被浏览器 locale 改写。
 * - 选择：日期部分用原生 <input type=date>（calendar），
 *   时间部分用自定义 24h 下拉（00-23 时、00/15/30/45 分），
 *   彻底回避原生 datetime-local 在英语 locale 下变 12h AM/PM。
 */
export default function YmdDateInput({
  value, max, min, onChange, includeTime = false, size = 'normal',
}: {
  value: string
  max?: string
  min?: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  includeTime?: boolean
  size?: 'normal' | 'compact'
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const dateInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)

  // 解析 value 为日期/时/分
  const iso = (value || '').slice(0, 16)
  const datePart = iso.slice(0, 10)
  const hourPart = iso.slice(11, 13) || '00'
  const minPart  = iso.slice(14, 16) || '00'

  // 分钟精度：只显示 'YYYY-MM-DD HH:mm'，不带秒
  const ctlVal = (value || '').slice(0, includeTime ? 16 : 10)
  const dispVal = includeTime ? ctlVal.replace('T', ' ') : ctlVal
  const placeholder = includeTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'
  const compact = size === 'compact'
  const width = includeTime
    ? (compact ? 'w-[140px]' : 'w-[160px]')
    : (compact ? 'w-[100px]' : 'w-[120px]')
  const sizing = compact
    ? 'pl-1.5 pr-6 h-6 text-[11px]'
    : 'pl-2 pr-7 h-8 text-[13px]'

  const emit = (newVal: string) => {
    onChange({ target: { value: newVal } } as React.ChangeEvent<HTMLInputElement>)
  }

  // 点击外部关闭弹层
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const handleOpen = () => {
    if (!includeTime) {
      // 仅日期模式：直接弹原生日历，不开自定义弹层
      const el = dateInputRef.current
      if (el && typeof el.showPicker === 'function') {
        try { el.showPicker(); return } catch { /* fall through */ }
      }
      el?.focus()
      return
    }
    setOpen(o => !o)
  }

  const onDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value
    if (!d) { emit(''); return }
    if (includeTime) emit(`${d}T${hourPart}:${minPart}`)
    else emit(d)
  }
  const onHourChange = (h: string) => {
    if (!datePart) {
      // 默认填今天
      const t = new Date()
      const today = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`
      emit(`${today}T${h}:${minPart}`)
    } else {
      emit(`${datePart}T${h}:${minPart}`)
    }
  }
  const onMinChange = (m: string) => {
    if (!datePart) {
      const t = new Date()
      const today = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`
      emit(`${today}T${hourPart}:${m}`)
    } else {
      emit(`${datePart}T${hourPart}:${m}`)
    }
  }

  const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
  const MINUTES = ['00', '15', '30', '45']

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <input
        readOnly
        type="text"
        value={dispVal}
        placeholder={placeholder}
        onClick={handleOpen}
        onFocus={handleOpen}
        className={`border border-gray-300 rounded ${sizing} ${width} bg-white cursor-pointer focus:outline-none focus:border-blue-400`}
      />
      <svg viewBox="0 0 24 24" width={compact ? 11 : 14} height={compact ? 11 : 14}
           className={`absolute ${compact ? 'right-1.5' : 'right-2'} pointer-events-none text-gray-500`}
           fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
      {/* 仅日期模式：隐藏原生 date 控件作为日历入口 */}
      {!includeTime && (
        <input
          ref={dateInputRef}
          type="date"
          value={ctlVal}
          max={max}
          min={min}
          onChange={onChange}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
        />
      )}
      {/* 分钟级：自定义 24h 弹层 */}
      {includeTime && open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3 flex items-center gap-2"
             style={{ minWidth: '320px' }}>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500">日期</span>
            {/* 原生 date 控件文字隐藏，自己叠一层 YYYY-MM-DD 显示，
                避免不同 locale 显示成 mm/dd/yyyy */}
            <div className="relative">
              <input type="date" value={datePart} max={max?.slice(0, 10)} min={min?.slice(0, 10)}
                     onChange={onDateChange}
                     style={{ color: 'transparent', caretColor: 'transparent', width: '120px' }}
                     className="border border-gray-300 rounded px-2 py-1 text-[12px] focus:outline-none focus:border-blue-400" />
              <div className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none text-[12px] text-gray-800">
                {datePart || 'YYYY-MM-DD'}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500">时</span>
            <select value={hourPart} onChange={e => onHourChange(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-[12px] bg-white focus:outline-none focus:border-blue-400">
              {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500">分</span>
            <select value={minPart} onChange={e => onMinChange(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-[12px] bg-white focus:outline-none focus:border-blue-400">
              {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="self-end ml-1 px-3 py-1 bg-blue-600 text-white text-[12px] rounded hover:bg-blue-700"
          >
            完成
          </button>
        </div>
      )}
    </div>
  )
}
