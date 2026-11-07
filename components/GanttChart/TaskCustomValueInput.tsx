'use client'

import type { TaskCustomField } from '@/types'

export default function TaskCustomValueInput({ field, value, onChange, onBlur, disabled, label }: {
  field: TaskCustomField; value: string; onChange: (value: string) => void
  onBlur?: () => void; disabled?: boolean; label?: string
}) {
  const props = { 'aria-label': label ?? field.name, value, disabled, onBlur,
    className: 'w-full min-w-[130px] rounded border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500 focus:outline-blue-400',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(e.target.value) }
  return field.type === 'select' ? <select {...props}>
    <option value="">未填写</option>
    {value && !field.options?.includes(value) && <option value={value}>{value}</option>}
    {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
  </select> : <input {...props} type={field.type === 'date' ? 'date' : 'text'}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
    inputMode={field.type === 'money' || field.type === 'number' ? 'decimal' : undefined}
    maxLength={field.type === 'text' ? 4000 : 40}
    placeholder={field.type === 'money' ? `金额${field.unit ? `（${field.unit}）` : ''}` : '未填写'} />
}
