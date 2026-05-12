'use client'

import React, { useRef } from 'react'

/**
 * 年-月-日（可选带 时:分）输入：上层为只读 text，强制以 24 小时 'YYYY-MM-DD[ HH:mm]'
 * 显示，避免被浏览器 locale 切到 MM/DD/YYYY 或 12 小时制；
 * 点击触发隐藏的原生 date/datetime-local 控件做选择。
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
  const ref = useRef<HTMLInputElement>(null)
  const openPicker = () => {
    const el = ref.current
    if (!el) return
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return } catch { /* fall through */ }
    }
    el.focus()
  }
  // 控件值用 16 位（datetime-local 在 step=900 下要求），展示文本补到 19 位（带 :00 秒位）
  const ctlVal = (value || '').slice(0, includeTime ? 16 : 10)
  const dispVal = includeTime
    ? (ctlVal ? `${ctlVal.replace('T', ' ')}:00` : '')
    : ctlVal
  const placeholder = includeTime ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD'
  const compact = size === 'compact'
  const width = includeTime
    ? (compact ? 'w-[160px]' : 'w-[180px]')
    : (compact ? 'w-[100px]' : 'w-[120px]')
  const sizing = compact
    ? 'pl-1.5 pr-6 h-6 text-[11px]'
    : 'pl-2 pr-7 h-8 text-[13px]'

  return (
    <div className="relative inline-flex items-center">
      <input
        readOnly
        type="text"
        value={dispVal}
        placeholder={placeholder}
        onClick={openPicker}
        onFocus={openPicker}
        className={`border border-gray-300 rounded ${sizing} ${width} bg-white cursor-pointer focus:outline-none focus:border-blue-400`}
      />
      <svg viewBox="0 0 24 24" width={compact ? 11 : 14} height={compact ? 11 : 14}
           className={`absolute ${compact ? 'right-1.5' : 'right-2'} pointer-events-none text-gray-500`}
           fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
      <input
        ref={ref}
        type={includeTime ? 'datetime-local' : 'date'}
        value={ctlVal}
        max={max}
        min={min}
        step={includeTime ? 60 * 15 : undefined}
        onChange={onChange}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
      />
    </div>
  )
}
