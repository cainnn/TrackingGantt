'use client'
import { useEffect, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setPlanBaseline } from '@/store/slices/projectSlice'
import { labelDraftStep } from '@/store/draftHistory'
import { authFetch } from '@/lib/client/authFetch'
import { makePlanBaseline, baselinesEqual } from '@/lib/planBaseline'
import { uuid } from '@/lib/uuid'
import type { ProjectVersion } from '@/types'

type HistoryEntry = { id: string; name: string; previous_name: string | null; reason: string; created_at: string; username: string | null }
export default function PlanBaselinePanel({ projectId, versions, readOnly }: { projectId: string; versions: ProjectVersion[]; readOnly?: boolean }) {
  const dispatch = useAppDispatch()
  const baseline = useAppSelector(s => s.project.currentProject?.plan_baseline)
  const saved = useAppSelector(s => s.draft.baseline?.planBaseline)
  const busy = useAppSelector(s => s.draft.saving || s.draft.uncertain || !!s.tasks.viewSnapshot)
  const [versionId, setVersionId] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyError, setHistoryError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setHistoryError('')
    authFetch(`/api/projects/${projectId}/baseline-history`).then(r => r.json()).then(data => {
      if (!data.ok) throw new Error(data.error ?? '加载基线记录失败')
      if (!cancelled) setHistory(data.value)
    }).catch(() => { if (!cancelled) setHistoryError('基线设定记录加载失败') })
    return () => { cancelled = true }
  }, [projectId, saved?.id, refresh])
  const apply = async () => {
    if (readOnly || busy || loading || !versionId || !reason.trim()) return
    setLoading(true); setError('')
    try {
      const response = await authFetch(`/api/versions/${projectId}?id=${encodeURIComponent(versionId)}`)
      const data = await response.json()
      if (!response.ok || !data.ok || !Array.isArray(data.value?.snapshot?.tasks)) throw new Error(data.error ?? '版本加载失败，请重试')
      dispatch(labelDraftStep('设定固定基线'))
      dispatch(setPlanBaseline({ projectId, baseline: makePlanBaseline(data.value, uuid(), reason) }))
      setReason(''); setVersionId('')
    } catch (err) { setError(err instanceof Error ? err.message : '基线设定失败') }
    finally { setLoading(false) }
  }
  return <section className="space-y-2 border-b border-blue-100 bg-blue-50/40 p-4 text-xs" aria-label="固定项目基线">
    <div className="flex items-center justify-between"><h3 className="font-semibold text-blue-900">固定项目基线</h3>{!baselinesEqual(baseline, saved) && <span className="text-amber-700">待保存</span>}</div>
    <p>{baseline ? `当前基线：${baseline.sourceVersionName}（${baseline.tasks.length} 项任务）` : '尚未设置固定基线'}</p>
    {baseline && <p className="break-words text-gray-600">原因：{baseline.reason}</p>}
    <p className="text-gray-500">基线独立保存，后续确认变更、覆盖或删除来源版本都不会改变它。可在显示设置中开启基线偏差列。</p>
    {!readOnly && <div className="space-y-2">
      <select aria-label="基线来源版本" value={versionId} disabled={busy || loading} onChange={e => setVersionId(e.target.value)} className="w-full rounded border bg-white p-2">
        <option value="">选择已保存的历史版本…</option>
        {versions.filter(v => !v.is_autosave).map(v => <option key={v.id} value={v.id}>{v.name} · #{v.version_number}</option>)}
      </select>
      {!versions.length && <p className="text-gray-500">稳定态确认保存后会生成可选的历史版本。</p>}
      <input aria-label="基线设定原因" maxLength={1000} value={reason} disabled={busy || loading} onChange={e => setReason(e.target.value)} placeholder="设定或更换基线的原因（必填）" className="w-full rounded border bg-white p-2" />
      <button disabled={busy || loading || !versionId || !reason.trim()} onClick={apply} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">{loading ? '读取版本中…' : '应用基线到草稿'}</button>
      <p className="text-gray-500">可撤销；点击顶部“保存／确认变更”后同步后台。</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>}
    <details><summary className="cursor-pointer text-blue-700">基线设定记录（最近 100 次）</summary>
      {historyError ? <button onClick={() => setRefresh(v => v + 1)} className="mt-2 text-red-700">{historyError}，点击重试</button> : !history.length ? <p className="mt-2 text-gray-500">暂无已保存记录</p> : history.map(entry => <div key={entry.id} className="mt-2 border-t pt-2">
        <p>{entry.previous_name ?? '未设置'} → {entry.name}</p><p className="break-words">{entry.reason}</p>
        <p className="text-gray-500">{entry.username ?? '已删除用户'} · {new Date(entry.created_at).toLocaleString()}</p>
      </div>)}
    </details>
  </section>
}
