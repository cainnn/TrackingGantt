'use client'
import { useEffect, useState } from 'react'
import { authFetch } from '@/lib/client/authFetch'

interface LogRow {
  id: string
  task_id: string
  task_code: string | null
  task_name: string | null
  status_date_at_change: string | null
  field: string
  old_value: string | null
  new_value: string | null
  reason: string | null
  changed_by_name: string | null
  changed_at: string
}

const FIELD_LABEL: Record<string, string> = {
  name: '名称',
  start_date: '开始日期',
  end_date: '结束日期',
  duration: '工期',
  percent_done: '完成度',
}

export default function RetroLogPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await authFetch(`/api/tasks/${projectId}/retrolog`)
        const j = await r.json()
        if (!cancelled && j.ok) setRows(j.value ?? [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectId])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[820px] max-h-[82vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-800">历史任务变更记录</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-sm text-gray-400">加载中…</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">暂无回溯修改记录</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 text-gray-500 text-left sticky top-0">
                <tr>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">任务</th>
                  <th className="px-3 py-2 font-medium">字段</th>
                  <th className="px-3 py-2 font-medium">原值 → 新值</th>
                  <th className="px-3 py-2 font-medium">状态日期</th>
                  <th className="px-3 py-2 font-medium">操作人</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-gray-100 hover:bg-blue-50/30">
                    <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{new Date(r.changed_at).toLocaleString('zh-CN')}</td>
                    <td className="px-3 py-1.5 text-gray-700">{r.task_code} {r.task_name}</td>
                    <td className="px-3 py-1.5 text-gray-700">{FIELD_LABEL[r.field] ?? r.field}</td>
                    <td className="px-3 py-1.5 text-gray-700">
                      <span className="text-red-500 line-through">{r.old_value ?? '（空）'}</span>
                      <span className="mx-1 text-gray-400">→</span>
                      <span className="text-green-600">{r.new_value ?? '（空）'}</span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{r.status_date_at_change ?? ''}</td>
                    <td className="px-3 py-1.5 text-gray-500">{r.changed_by_name ?? ''}</td>
                    <td className="px-3 py-1.5 text-gray-500">{r.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
