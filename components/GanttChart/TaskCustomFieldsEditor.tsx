'use client'

import { useState } from 'react'
import type { TaskCustomField, TaskCustomFieldType } from '@/types'
import { CUSTOM_FIELD_TYPES, normalizeCustomFields } from '@/lib/taskCustomFields'
import { uuid } from '@/lib/uuid'

export default function TaskCustomFieldsEditor({ fields, initialDraft, readOnly = false, onApply, onDraftChange }: {
  fields: TaskCustomField[]; initialDraft?: TaskCustomField[]; readOnly?: boolean; onApply: (fields: TaskCustomField[]) => void; onDraftChange?: (fields: TaskCustomField[]) => void
}) {
  const [draft, setDraft] = useState(initialDraft ?? fields)
  const [error, setError] = useState('')
  const change = (next: TaskCustomField[]) => { setDraft(next); onDraftChange?.(next); setError('') }
  const update = (id: string, patch: Partial<TaskCustomField>) => change(draft.map(f => f.id === id ? { ...f, ...patch } : f))
  const add = () => {
    change([...draft, { id: uuid(), name: '', type: 'text' }])
  }
  const apply = () => {
    try { onApply(normalizeCustomFields(draft, fields)); setError('') }
    catch (err) { setError(err instanceof Error ? err.message : '属性配置无效') }
  }
  return <div className="flex min-h-0 flex-col" onKeyDown={e => e.stopPropagation()}>

        <div className="overflow-auto p-5">
          <p className="mb-3 text-xs text-gray-500">为当前任务自定义属性名称和类型。停用属性会保留已有数据，其他任务的属性不受影响。</p>
          <div className="space-y-3">
            {draft.map(field => <div key={field.id} className={`grid grid-cols-[minmax(0,1fr)_100px] gap-3 rounded border p-3 ${field.archived ? 'bg-gray-50 opacity-70' : 'bg-white'}`}>
              <label className="text-xs text-gray-500">属性名称<input aria-label="属性名称" value={field.name} maxLength={60} disabled={readOnly} onChange={e => update(field.id, { name: e.target.value })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label>
              <label className="text-xs text-gray-500">类型<select aria-label={`${field.name || '新属性'}类型`} value={field.type} disabled={readOnly || fields.some(f => f.id === field.id)} onChange={e => update(field.id, { type: e.target.value as TaskCustomFieldType, options: e.target.value === 'select' ? ['选项一'] : undefined })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800">
                {Object.entries(CUSTOM_FIELD_TYPES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select></label>
              {field.type === 'select' ? <label className="text-xs text-gray-500">选项（每行一个）<textarea aria-label={`${field.name}选项`} rows={2} disabled={readOnly} value={field.options?.join('\n') ?? ''} onChange={e => update(field.id, { options: e.target.value.split('\n') })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label>
                : field.type === 'money' || field.type === 'number' ? <label className="text-xs text-gray-500">单位（选填）<input aria-label={`${field.name}单位`} disabled={readOnly} maxLength={12} value={field.unit ?? ''} onChange={e => update(field.id, { unit: e.target.value })} placeholder={field.type === 'money' ? '元' : '如：台、件'} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label> : <div />}
              {!readOnly && <button className="self-center text-sm text-blue-600" onClick={() => fields.some(f => f.id === field.id) ? update(field.id, { archived: !field.archived }) : change(draft.filter(f => f.id !== field.id))}>{fields.some(f => f.id === field.id) ? field.archived ? '启用' : '停用' : '移除'}</button>}
            </div>)}
          </div>
          {!draft.length && <div className="py-8 text-center text-sm text-gray-400">尚未配置任务属性</div>}
          {!readOnly && <div className="mt-4 text-sm text-blue-600"><button onClick={add}>＋ 新增属性</button></div>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <span role="alert" className="text-sm text-red-600">{error}</span>
          {!readOnly && <button onClick={apply} className="shrink-0 rounded bg-blue-600 px-4 py-2 text-sm text-white">完成设置</button>}
        </div>

  </div>
}
