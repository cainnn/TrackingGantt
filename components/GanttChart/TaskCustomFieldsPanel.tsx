'use client'

import { useEffect, useRef } from 'react'
import type { Task, TaskCustomField } from '@/types'
import { CUSTOM_FIELD_TYPES, formatCustomValue } from '@/lib/taskCustomFields'

/** Task-specific, read-only inspection for historical versions and viewers. */
export default function TaskCustomFieldsPanel({ task, fields, onClose }: {
  task: Task; fields: TaskCustomField[]; onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose])
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section role="dialog" aria-modal="true" aria-label="任务属性" className="max-h-[85vh] w-[540px] max-w-[95vw] overflow-auto rounded-lg bg-white shadow-xl">
      <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div><h2 className="font-semibold">任务属性</h2><p className="mt-1 text-sm text-gray-500">{task.name} · 只读</p></div>
        <button ref={closeRef} aria-label="关闭任务属性" onClick={onClose} className="text-xl text-gray-500">×</button>
      </header>
      <dl className="space-y-4 px-5 py-4">
        {fields.map(field => <div key={field.id}>
          <dt className="text-sm text-gray-500">{field.name} · {CUSTOM_FIELD_TYPES[field.type]}{field.archived ? '（已停用）' : ''}</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{formatCustomValue(task.custom_values?.[field.id], field) || '未填写'}</dd>
        </div>)}
        {!fields.length && <p className="py-4 text-center text-sm text-gray-400">此任务尚无自定义属性</p>}
      </dl>
    </section>
  </div>
}
