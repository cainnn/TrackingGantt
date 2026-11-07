'use client'

import { useState } from 'react'
import type { Task, TaskCustomField } from '@/types'
import { customValuesEqual, formatCustomValue, normalizeCustomValues } from '@/lib/taskCustomFields'
import TaskCustomFieldsEditor from './TaskCustomFieldsEditor'
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
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const visibleFields = fields.filter(f => showArchived || !f.archived)
  const shownTasks = tasks.filter(t => !t.is_deleted && (!search || `${t.task_code} ${t.name}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => a.order_index - b.order_index)
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="任务属性" onKeyDown={e => e.stopPropagation()}>
    <div className="flex max-h-[85vh] w-[1050px] max-w-full flex-col rounded-xl bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="font-semibold text-gray-900">任务属性</h2>
        <button onClick={onClose} aria-label="关闭任务属性" className="px-2 text-xl text-gray-500">×</button>
      </div>
      <p className="px-5 pt-3 text-xs leading-5 text-gray-500">为本项目的任务记录金额或其他信息。填报后可逐步撤销，点击顶部“确认变更”才会入库。金额最多两位小数，允许负数；空值表示未填写。</p>
      <div className="flex gap-5 border-b px-5 pt-3 text-sm">
        {([['values', '属性填报'], ['fields', '属性配置']] as const).map(([key, title]) => <button key={key} onClick={() => setTab(key)} className={`border-b-2 pb-2 ${tab === key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500'}`}>{title}</button>)}
      </div>
      {tab === 'fields' ? <TaskCustomFieldsEditor fields={fields} readOnly={readOnly} onApply={next => { onFieldsChange(next); setTab('values') }} /> : <>
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
