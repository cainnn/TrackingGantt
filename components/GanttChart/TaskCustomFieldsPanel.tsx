'use client'

import { useState } from 'react'
import type { Task, TaskCustomField, TaskCustomFieldType } from '@/types'
import { CUSTOM_FIELD_TYPES, customValuesEqual, formatCustomValue, normalizeCustomFields, normalizeCustomValues } from '@/lib/taskCustomFields'
import { uuid } from '@/lib/uuid'
import TaskCustomValueInput from './TaskCustomValueInput'

function ValueCell({ task, field, readOnly, onUpdate }: { task: Task; field: TaskCustomField; readOnly: boolean; onUpdate: (task: Task) => void }) {
  const saved = task.custom_values?.[field.id] ?? ''
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const commit = () => {
    if (editing === null) return
    try {
      const values = normalizeCustomValues({ [field.id]: editing }, [field], task.custom_values)
      if (!customValuesEqual(values, task.custom_values)) onUpdate({ ...task, custom_values: values })
      setEditing(null); setError('')
    } catch (err) { setError(err instanceof Error ? err.message : '填写内容无效') }
  }
  return <td className="border-b border-gray-100 p-2 align-top">
    {readOnly || field.archived ? <span className="text-sm">{formatCustomValue(saved, field) || '—'}</span> : <TaskCustomValueInput
      field={field} value={editing ?? saved} onChange={v => { setEditing(v); setError('') }} onBlur={commit} label={`${task.name} · ${field.name}`} />}
    {error && <div role="alert" className="mt-1 max-w-52 text-xs text-red-600">{error}</div>}
  </td>
}

export default function TaskCustomFieldsPanel({ fields, tasks, readOnly, onFieldsChange, onTaskChange, onClose }: {
  fields: TaskCustomField[]; tasks: Task[]; readOnly: boolean
  onFieldsChange: (fields: TaskCustomField[]) => void; onTaskChange: (task: Task) => void; onClose: () => void
}) {
  const [tab, setTab] = useState<'values' | 'fields'>(fields.some(f => !f.archived) ? 'values' : 'fields')
  const [draft, setDraft] = useState(fields)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const visibleFields = fields.filter(f => showArchived || !f.archived)
  const shownTasks = tasks.filter(t => !t.is_deleted && (!search || `${t.task_code} ${t.name}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => a.order_index - b.order_index)
  const update = (id: string, patch: Partial<TaskCustomField>) => { setDraft(d => d.map(f => f.id === id ? { ...f, ...patch } : f)); setError('') }
  const add = (money = false) => {
    setDraft(d => [...d, { id: uuid(), name: money ? '支出金额' : '', type: money ? 'money' : 'text', ...(money ? { unit: '元' } : {}) }])
    setError('')
  }
  const apply = () => {
    try {
      const normalized = normalizeCustomFields(draft, fields)
      onFieldsChange(normalized); setDraft(normalized); setError(''); setTab('values')
    } catch (err) { setError(err instanceof Error ? err.message : '属性配置无效') }
  }
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="任务属性" onKeyDown={e => e.stopPropagation()}>
    <div className="flex max-h-[85vh] w-[1050px] max-w-full flex-col rounded-xl bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="font-semibold text-gray-900">任务属性</h2>
        <button onClick={onClose} aria-label="关闭任务属性" className="px-2 text-xl text-gray-500">×</button>
      </div>
      <p className="px-5 pt-3 text-xs leading-5 text-gray-500">为本项目的任务记录金额或其他信息。填报后可逐步撤销，点击顶部“确认更改”才会入库。金额最多两位小数，允许负数；空值表示未填写。</p>
      <div className="flex gap-5 border-b px-5 pt-3 text-sm">
        {([['values', '属性填报'], ['fields', '属性配置']] as const).map(([key, title]) => <button key={key} onClick={() => setTab(key)} className={`border-b-2 pb-2 ${tab === key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500'}`}>{title}</button>)}
      </div>
      {tab === 'fields' ? <>
        <div className="overflow-auto p-5">
          <p className="mb-3 text-xs text-gray-500">属性名称可修改。已应用的属性类型不可更改，单选选项可追加；停用属性仍保留原有数据。</p>
          <div className="space-y-3">
            {draft.map(field => <div key={field.id} className={`grid grid-cols-[minmax(140px,1fr)_110px_minmax(150px,1fr)_80px] gap-3 rounded border p-3 ${field.archived ? 'bg-gray-50 opacity-70' : 'bg-white'}`}>
              <label className="text-xs text-gray-500">属性名称<input aria-label="属性名称" value={field.name} maxLength={60} disabled={readOnly} onChange={e => update(field.id, { name: e.target.value })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label>
              <label className="text-xs text-gray-500">类型<select aria-label={`${field.name || '新属性'}类型`} value={field.type} disabled={readOnly || fields.some(f => f.id === field.id)} onChange={e => update(field.id, { type: e.target.value as TaskCustomFieldType, options: e.target.value === 'select' ? ['选项一'] : undefined })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800">
                {Object.entries(CUSTOM_FIELD_TYPES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select></label>
              {field.type === 'select' ? <label className="text-xs text-gray-500">选项（每行一个）<textarea aria-label={`${field.name}选项`} rows={2} disabled={readOnly} value={field.options?.join('\n') ?? ''} onChange={e => update(field.id, { options: e.target.value.split('\n') })} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label>
                : field.type === 'money' || field.type === 'number' ? <label className="text-xs text-gray-500">单位（选填）<input aria-label={`${field.name}单位`} disabled={readOnly} maxLength={12} value={field.unit ?? ''} onChange={e => update(field.id, { unit: e.target.value })} placeholder={field.type === 'money' ? '元' : '如：台、件'} className="mt-1 w-full rounded border p-2 text-sm text-gray-800" /></label> : <div />}
              {!readOnly && <button className="self-center text-sm text-blue-600" onClick={() => fields.some(f => f.id === field.id) ? update(field.id, { archived: !field.archived }) : setDraft(d => d.filter(f => f.id !== field.id))}>{fields.some(f => f.id === field.id) ? field.archived ? '启用' : '停用' : '移除'}</button>}
            </div>)}
          </div>
          {!draft.length && <div className="py-8 text-center text-sm text-gray-400">尚未配置任务属性</div>}
          {!readOnly && <div className="mt-4 flex gap-3 text-sm text-blue-600"><button onClick={() => add()}>＋ 新增属性</button><button onClick={() => add(true)}>＋ 支出金额（元）</button></div>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <span role="alert" className="text-sm text-red-600">{error}</span>
          {!readOnly && <button onClick={apply} className="shrink-0 rounded bg-blue-600 px-4 py-2 text-sm text-white">应用属性配置</button>}
        </div>
      </> : <>
        <div className="flex items-center gap-4 px-5 py-3 text-sm">
          <input aria-label="搜索填报任务" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索任务名称或编号" className="w-64 rounded border px-3 py-2" />
          <label className="text-gray-500"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> 显示停用属性</label>
          <span className="ml-auto text-gray-400">{shownTasks.length} 个任务</span>
        </div>
        <div className="overflow-auto px-5 pb-5">
          {visibleFields.length ? <table className="w-full border-collapse text-left"><thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-600"><tr><th className="min-w-48 p-2">任务</th>{visibleFields.map(f => <th key={f.id} className="min-w-44 p-2">{f.name}{f.unit ? `（${f.unit}）` : ''}{f.archived ? ' · 已停用' : ''}</th>)}</tr></thead>
            <tbody>{shownTasks.map(task => <tr key={task.id}><th className="border-b border-gray-100 p-2 text-sm font-normal">{task.task_code} · {task.name}</th>{visibleFields.map(field => <ValueCell key={field.id} task={task} field={field} readOnly={readOnly} onUpdate={onTaskChange} />)}</tr>)}</tbody></table>
            : <div className="py-12 text-center text-sm text-gray-500">请先在“属性配置”中添加属性，例如“支出金额”。</div>}
        </div>
      </>}
    </div>
  </div>
}
