'use client'

import { useState } from 'react'
import type { Task } from '@/types'
import type { planUnlinkedTaskStarts } from '@/lib/unlinkedTaskSchedule'
import { toDateTimeStr } from '@/lib/clientTime'
import { CONSTRAINT_TYPES } from './constants'

export default function SaveStartAlignmentDialog({ before, proposal, isMinute, error, onCancel, onConfirm }: {
  before: Task[]
  proposal: ReturnType<typeof planUnlinkedTaskStarts>
  isMinute: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const [page, setPage] = useState(0)
  const original = new Map(before.map(t => [t.id, t]))
  const direct = new Set(proposal.directTaskIds)
  const summaries = new Set(proposal.tasks.filter(t => !t.is_deleted).map(t => t.parent_id))
  const format = (date: string | null | undefined) => toDateTimeStr(date)?.slice(0, isMinute ? 16 : 10).replace('T', ' ') ?? '—'
  const pages = Math.max(1, Math.ceil(proposal.updatedTasks.length / 50))
  const currentPage = Math.min(page, pages - 1)
  return <div role="dialog" aria-modal="true" aria-label="保存前排程提示" className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/40 p-4" onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    if (event.key === 'Tab') {
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
      <div className="border-b border-gray-200 px-5 py-4">
        <h2 className="text-lg font-semibold">保存前排程提示</h2>
        <p className="mt-2 text-sm text-gray-700">由于任务类型为“自动”、限制类型为“尽早”或“无”，且没有有效前置任务，以下 {proposal.directTaskIds.length} 个任务的开始时间将在保存时提前到 <strong>{format(proposal.anchor)}</strong>。请核对调整结果后确认。</p>
        <p className="mt-2 text-xs text-gray-500">普通任务工期保持不变，后续日期联动调整，父任务起止日期及工期按子任务重新汇总。手动排程、指定日期限制和已开始的任务不会直接对齐；如需保留未来日期，请返回编辑并设置手动排程或日期限制。</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {error && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-white text-xs text-gray-500"><tr><th className="py-2">任务</th><th>任务类型 / 限制类型</th><th>调整原因</th><th>开始时间（原 → 新）</th><th>完成时间（原 → 新）</th></tr></thead>
          <tbody>{proposal.updatedTasks.slice(currentPage * 50, (currentPage + 1) * 50).map(task => <tr key={task.id} data-save-start-task={task.id} className="border-t border-gray-100">
            <td className="max-w-64 break-words py-3 pr-3">{task.name}</td>
            <td className="whitespace-nowrap pr-3 text-xs text-gray-600">{summaries.has(task.id) ? '父任务汇总' : `${task.auto_schedule === false ? '手动' : '自动'} / ${CONSTRAINT_TYPES.find(c => c.value === (task.constraint_type ?? 'none'))?.label ?? '无'}`}</td>
            <td className="whitespace-nowrap pr-3 text-xs text-gray-500">{direct.has(task.id) ? '无前置任务' : summaries.has(task.id) ? '父任务汇总' : '后续联动'}</td>
            {(['start_date', 'end_date'] as const).map(field => <td key={field} className="whitespace-nowrap py-2 pr-3 text-xs"><div className="text-gray-500">{format(original.get(task.id)?.[field])}</div><div className="mt-1 text-blue-700">→ {format(task[field])}</div></td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-gray-500"><span>共 {proposal.updatedTasks.length} 个任务受影响</span>{pages > 1 && <><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)} className="text-blue-600 disabled:opacity-40">上一页</button><span>{currentPage + 1} / {pages}</span><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)} className="text-blue-600 disabled:opacity-40">下一页</button></>}</div>
        <div className="flex gap-2"><button autoFocus type="button" onClick={onCancel} className="rounded border border-gray-300 bg-white px-4 py-2 text-sm">返回编辑</button><button type="button" onClick={onConfirm} className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">确认调整并继续保存</button></div>
      </div>
    </div>
  </div>
}
