'use client'

import { useMemo, useState } from 'react'
import type { SaveBaseline } from '@/lib/clientSave'
import { reconcilePlanSave, describeSaveDifference, reconciliationHierarchyIssues, type SaveChoice } from '@/lib/planSaveReconciliation'

export default function SaveConflictDialog({ baseline, persisted, current, attempts, busy, error, onClose, onApply }: {
  baseline: SaveBaseline; persisted: SaveBaseline; current: SaveBaseline; attempts: SaveBaseline[]
  busy: boolean; error: string; onClose: () => void
  onApply: (plan: SaveBaseline, reviewed: SaveBaseline, continueSaving?: boolean) => void
}) {
  const [choices, setChoices] = useState<Record<string, SaveChoice>>({})
  const [showUpdates, setShowUpdates] = useState(false)
  const result = useMemo(() => reconcilePlanSave(baseline, persisted, current, attempts, choices), [baseline, persisted, current, attempts, choices])
  const hierarchyIssues = reconciliationHierarchyIssues(result.plan)
  const conflicts = result.differences.filter(d => d.conflict)
  const updates = result.differences.filter(d => !d.conflict)
  const rows = showUpdates ? [...conflicts, ...updates] : conflicts
  return <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="核对后台变更">
    <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl">
      <div className="border-b border-gray-200 px-5 py-4">
        <h2 className="text-lg font-semibold">核对后台变更</h2>
        <p className="mt-2 text-sm text-gray-600">当前草稿仍保留。未冲突的后台更新会合并；双方都修改过的内容，请选择保留哪一份。</p>
        <p className="mt-1 text-sm text-gray-600">可先应用到草稿查看，也可应用后继续保存。只有明确选择的冲突内容会覆盖后台。</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
          <span>{conflicts.length} 项冲突，{result.unresolved.length} 项待选择</span>
          {!!updates.length && <button type="button" className="text-blue-600" onClick={() => setShowUpdates(v => !v)}>{showUpdates ? '收起' : '查看'} {updates.length} 项可合并更新</button>}
        </div>
        {!conflicts.length && <p className="mb-3 rounded bg-blue-50 p-3 text-sm text-blue-800">没有双方争用的字段，可以保留后台更新并继续处理本地草稿。</p>}
        {!!conflicts.length && <div className="mb-3 flex flex-wrap gap-4 text-xs text-blue-600">
          <button type="button" disabled={busy} onClick={() => setChoices(prev => ({ ...prev, ...Object.fromEntries(conflicts.map(row => [row.key, 'local' as const])) }))}>冲突项全部保留我的修改</button>
          <button type="button" disabled={busy} onClick={() => setChoices(prev => ({ ...prev, ...Object.fromEntries(conflicts.map(row => [row.key, 'remote' as const])) }))}>冲突项全部采用后台</button>
        </div>}
        <div className="space-y-4">{rows.map(row => <fieldset key={row.key} data-save-difference={row.key} className="min-w-0 rounded border border-gray-200 p-3">
          <legend className="max-w-full break-words px-1 text-sm font-semibold">{row.title}{row.conflict ? '' : ' · 可合并'}</legend>
          <details className="mb-2 text-xs text-gray-500"><summary className="cursor-pointer">打开页面时的内容</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words py-2 font-sans">{describeSaveDifference(row, 'before')}</pre></details>
          <div className="grid gap-3 sm:grid-cols-2">{(['local', 'remote'] as const).map(side => <label key={side} className={`min-w-0 cursor-pointer rounded border p-3 ${(choices[row.key] ?? row.suggested) === side ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
            <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name={row.key} value={side} disabled={busy}
              checked={(choices[row.key] ?? row.suggested) === side} onChange={() => setChoices(prev => ({ ...prev, [row.key]: side }))} />{side === 'local' ? '保留我的修改' : '采用后台内容'}</span>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs font-sans text-gray-700">{describeSaveDifference(row, side)}</pre>
          </label>)}</div>
        </fieldset>)}</div>
        {!result.unresolved.length && hierarchyIssues.length > 0 && <div role="alert" className="mt-3 text-sm text-red-600">{hierarchyIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
        <span className="text-xs text-gray-500">应用后的草稿可撤销到最新后台内容。</span>
        <div className="flex gap-2">
          <button type="button" disabled={busy} className="rounded border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50" onClick={onClose}>返回草稿</button>
          <button type="button" disabled={busy || !!result.unresolved.length || !!hierarchyIssues.length} className="rounded border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50" onClick={() => onApply(result.plan, current)}>{busy ? '核对中…' : '应用到草稿'}</button>
          <button type="button" disabled={busy || !!result.unresolved.length || !!hierarchyIssues.length} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:bg-gray-300" onClick={() => onApply(result.plan, current, true)}>应用并继续保存</button>
        </div>
      </div>
    </div>
  </div>
}
