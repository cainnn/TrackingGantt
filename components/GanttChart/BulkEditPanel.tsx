'use client'

import { useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { labelDraftStep } from '@/store/draftHistory'
import { updateTasks, markDirty, setEditDescription } from '@/store/slices/tasksSlice'
import { buildBulkEdit, selectedTreeIds } from '@/lib/clientBulkEdit'
import { findUpperConstraintViolations } from '@/lib/clientScheduling'
import { toDateTimeStr } from '@/lib/clientTime'

export default function BulkEditPanel({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch()
  const { tasks, dependencies, selectedIds } = useAppSelector(s => s.tasks)
  const project = useAppSelector(s => s.project.currentProject)
  const isMinute = project?.time_granularity === 'minute'
  const [changeAssignee, setChangeAssignee] = useState(false)
  const [assignee, setAssignee] = useState('')
  const [schedule, setSchedule] = useState('keep')
  const [shift, setShift] = useState('0')
  const [error, setError] = useState('')
  const count = useMemo(() => selectedTreeIds(tasks, selectedIds).size, [tasks, selectedIds])
  const apply = () => {
    try {
      const today = toDateTimeStr(new Date())!
      const anchor = [isMinute ? today : `${today.slice(0, 10)}T00:00:00`, project?.status_date ?? '', project?.start_date ?? ''].sort().at(-1)!
      const updates = buildBulkEdit(tasks, dependencies, selectedIds, {
        ...(changeAssignee ? { assignee: assignee.trim() || null } : {}),
        ...(schedule !== 'keep' ? { autoSchedule: schedule === 'auto' } : {}),
        shiftMinutes: Number(shift) * (isMinute ? 1 : 1440),
      }, isMinute, anchor)
      const constraints = findUpperConstraintViolations(updates)
      const outside = updates.filter(t => t.start_date && project?.start_date && t.start_date < project.start_date && t.project_boundary !== 'ignore')
      if (outside.some(t => t.project_boundary === 'honor')) throw new Error('部分任务不允许移到项目开始日期之前，请调整移动量')
      if ((constraints.length || outside.length) && !confirm(`本次修改有 ${constraints.length} 项限制日期冲突、${outside.length} 项越过项目开始日期。确认应用到草稿？`)) return
      dispatch(labelDraftStep('批量修改任务'))
      dispatch(updateTasks(updates))
      dispatch(markDirty(updates.map(t => t.id)))
      for (const id of selectedIds) dispatch(setEditDescription({ taskId: id, description: '批量修改责任人、排程或日期' }))
      onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  return <div role="dialog" aria-modal="true" aria-label="批量修改任务" className="fixed inset-0 z-[9000] bg-black/40 flex items-center justify-center">
    <div className="bg-white rounded-lg shadow-xl p-5 w-[420px] space-y-4 text-sm">
      <h2 className="font-semibold">批量修改 {count} 个任务</h2>
      <p className="text-xs text-gray-500">包含所选摘要下的子任务，应用后可整步撤销。</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={changeAssignee} onChange={e => setChangeAssignee(e.target.checked)} />修改责任人
        <input aria-label="批量责任人" disabled={!changeAssignee} className="border rounded px-2 py-1 w-40" placeholder="留空表示清除" value={assignee} onChange={e => setAssignee(e.target.value)} /></label>
      <label className="flex gap-2 items-center">排程模式<select aria-label="批量排程模式" value={schedule} onChange={e => setSchedule(e.target.value)} className="border rounded p-1"><option value="keep">保持原值</option><option value="auto">自动</option><option value="manual">手动</option></select></label>
      <label className="flex gap-2 items-center">整体移动<input aria-label="批量移动量" type="number" step="1" className="border rounded px-2 py-1 w-24" value={shift} onChange={e => setShift(e.target.value)} />{isMinute ? '分钟' : '天'}</label>
      <p className="text-xs text-gray-500">正数后移、负数前移。移动的普通任务会切换为手动排程，依赖关系保留。</p>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex justify-end gap-3"><button onClick={onClose}>取消</button><button disabled={!changeAssignee && schedule === 'keep' && !Number(shift)} onClick={apply} className="bg-blue-600 text-white rounded px-3 py-2 disabled:opacity-40">应用到草稿</button></div>
    </div>
  </div>
}
