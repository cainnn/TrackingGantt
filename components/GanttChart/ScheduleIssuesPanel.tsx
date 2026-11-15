'use client'
import { useEffect, useMemo } from 'react'
import type { Task, Dependency } from '@/types'
import { getPlanScheduleIssues } from '@/lib/planScheduleValidation'
import { analyzeSchedule } from '@/lib/scheduleAnalysis'

export default function ScheduleIssuesPanel({ tasks, dependencies, onClose, onLocate, onEdit, onUndo, projectFinish }: {
  tasks: Task[]; dependencies: Dependency[]; projectFinish?: string | null
  onClose: () => void; onLocate: (id: string) => void; onEdit?: (id: string) => void; onUndo?: () => void
}) {
  const issues = useMemo(() => getPlanScheduleIssues(tasks, dependencies), [tasks, dependencies])
  const analysis = useMemo(() => analyzeSchedule(tasks, dependencies, projectFinish), [tasks, dependencies, projectFinish])
  const errors = issues.filter(i => i.severity === 'error').length
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose])
  return <div className="fixed inset-0 z-[10000] flex justify-end bg-black/20" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section role="dialog" aria-modal="true" aria-label="排程检查" className="flex h-full w-[480px] max-w-full flex-col bg-white shadow-xl">
      <div className="border-b p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">排程检查</h2><button autoFocus aria-label="关闭排程检查" onClick={onClose}>关闭</button></div>
        <p className="mt-2 text-sm text-gray-600">{errors} 项冲突，{issues.length - errors} 项提醒。修改后自动重新检查。</p>
        <p className="mt-1 text-xs text-gray-500">手动任务不随前置自动调整；截止日期提醒不阻止保存。编辑仍需通过顶部保存。</p>
        {onUndo && <button onClick={onUndo} className="mt-2 rounded border px-3 py-1 text-sm">撤销上一步</button>}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {!issues.length && <p className="rounded bg-green-50 p-3 text-sm text-green-800">未发现阻止保存的排程冲突或截止日期提醒。</p>}
        {issues.map(issue => <article key={issue.id} data-schedule-issue={issue.kind} className={`rounded border p-3 text-sm ${issue.severity === 'error' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
          <h3 className="font-medium">{issue.message}</h3><p className="mt-1 break-words text-xs text-gray-600">{issue.detail}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-blue-700">
            {issue.taskId && <button onClick={() => onLocate(issue.taskId)}>定位任务</button>}
            {issue.taskId && onEdit && <button onClick={() => onEdit(issue.taskId)}>编辑任务</button>}
            {issue.relatedTaskId && onEdit && <button onClick={() => onEdit(issue.relatedTaskId!)}>编辑前置任务</button>}
          </div>
        </article>)}
        <div className="border-t pt-3 text-xs text-gray-600"><p>总时差表示按当前计划及限制，任务还能推迟多少时间。零为没有余量，负值表示需提前；手动任务、摘要任务及无法可靠分析的任务显示“—”。</p>
          {analysis.warnings.map(warning => <p key={warning} className="mt-2 text-amber-800">{warning}</p>)}
        </div>
      </div>
    </section>
  </div>
}
