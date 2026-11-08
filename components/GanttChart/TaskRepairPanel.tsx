'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '@/types'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { labelDraftStep } from '@/store/draftHistory'
import { markDirty, setEditDescription, updateTasks } from '@/store/slices/tasksSlice'
import { buildTaskRepair } from '@/lib/clientTaskRepair'
import { toDateTimeStr } from '@/lib/clientTime'

const today = () => toDateTimeStr(new Date())!.slice(0, 10)
const PAGE_SIZE = 100

export default function TaskRepairPanel({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const dispatch = useAppDispatch()
  const dependencies = useAppSelector(state => state.tasks.dependencies)
  const project = useAppSelector(state => state.project.currentProject)
  const history = useAppSelector(state => state.draft)
  const isMinute = project?.time_granularity === 'minute'
  const [date, setDate] = useState(today)
  const [page, setPage] = useState(0)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const plan = useMemo(() => buildTaskRepair(tasks, dependencies, date, isMinute), [tasks, dependencies, date, isMinute])
  const direct = new Set(plan.repairedIds)
  const changed = new Map(plan.updates.map(task => [task.id, task]))
  const rows = tasks.map((task, index) => ({ before: task, after: changed.get(task.id), number: index + 1 }))
    .filter(row => row.after)
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const format = (value: string | null) => toDateTimeStr(value)?.slice(0, isMinute ? 16 : 10).replace('T', ' ') ?? '—'
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus()
  }, [])
  const apply = () => {
    if (!project || history.saving || history.uncertain) return
    const currentDate = today()
    if (date !== currentDate) {
      setDate(currentDate); setPage(0); setNotice('日期已变化，已重新检查，请核对后执行修复。'); return
    }
    if (!plan.repairedIds.length) return
    dispatch(labelDraftStep('修复自动任务开始日期'))
    dispatch(updateTasks(plan.updates))
    dispatch(markDirty(plan.repairedIds))
    for (const taskId of plan.repairedIds) dispatch(setEditDescription({ taskId, description: `任务检查：将无前置任务的自动尽早任务提前至 ${date}` }))
    onClose()
  }
  return <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="任务检查与修复" tabIndex={-1}
      className="flex max-h-[85vh] w-[1040px] max-w-full flex-col overflow-hidden rounded-xl bg-white text-sm shadow-xl outline-none"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); onClose() }
        if (event.key !== 'Tab') return
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
        <h2 className="text-lg font-semibold text-gray-900">任务检查与修复</h2>
        <button aria-label="关闭任务检查" onClick={onClose} className="rounded px-2 py-1 text-xl text-gray-500 hover:bg-gray-100">×</button>
      </div>
      <div className="space-y-2 px-6 py-4 text-gray-600">
        <p>检查整个项目：将<strong className="font-medium text-gray-900">自动排程、限制为“尽早（越早越好）”、没有前置任务</strong>且开始日期晚于今天的任务，提前到 <strong className="text-blue-700">{date}</strong>。</p>
        <p className="text-xs">工期保持不变{isMinute ? '，分钟级任务保留原来的时分' : ''}。已开始、无效任务不调整；摘要任务随子任务汇总，自动后续任务按依赖和限制联动。</p>
      </div>
      {rows.length ? <>
        <p className="mx-6 mb-3 rounded-lg bg-blue-50 px-3 py-2 text-blue-800">发现 {plan.repairedIds.length} 个待修复任务，另有 {rows.length - plan.repairedIds.length} 个任务联动调整。</p>
        <div className="min-h-0 overflow-auto border-y border-gray-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-gray-50 text-gray-500"><tr>
              {['编号 / 任务', '处理方式', '开始日期', '修复后开始', '结束日期', '修复后结束'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}
            </tr></thead>
            <tbody>{rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ before, after, number }) => <tr key={before.id} data-repair-task={before.id} className="border-t border-gray-100">
              <td className="max-w-64 px-4 py-3"><span className="mr-2 text-gray-400">#{number}</span>{before.name}</td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-500">{direct.has(before.id) ? '提前至今天' : '自动联动'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-500">{format(before.start_date)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-blue-700">{format(after!.start_date)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-500">{format(before.end_date)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-blue-700">{format(after!.end_date)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {pageCount > 1 && <div className="flex items-center justify-end gap-3 px-6 py-2 text-xs">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="disabled:text-gray-300">上一页</button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)} className="disabled:text-gray-300">下一页</button>
        </div>}
      </> : <p role="status" className="mx-6 mb-4 rounded-lg bg-green-50 px-4 py-6 text-green-800">检查完成，没有需要修复的任务。</p>}
      {notice && <p role="status" className="px-6 pt-3 text-amber-700">{notice}</p>}
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <p className="text-xs text-gray-500">修复后可一步撤销。{project?.planning_status === 'draft' ? '点击顶部“保存”入库。' : '点击顶部“确认变更”，填写原因后入库。'}</p>
        <div className="flex shrink-0 gap-3">
          <button onClick={onClose} className="rounded border border-gray-300 px-4 py-2">取消</button>
          <button onClick={apply} disabled={!plan.repairedIds.length || history.saving || history.uncertain}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400">修复 {plan.repairedIds.length} 个任务</button>
        </div>
      </div>
    </div>
  </div>
}
