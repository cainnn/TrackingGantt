'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setVersions, addVersion, updateVersion, removeVersion } from '@/store/slices/versionsSlice'
import { setTasks, setComparison, clearComparison, setDiffFilter, clearDiffFilter, setViewSnapshot } from '@/store/slices/tasksSlice'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { diffSnapshots, type SnapshotTask } from '@/lib/versionDiff'
import type { ProjectVersion, TaskLifecycleEvent } from '@/types'

interface DiffItem {
  task_code: string
  task_name: string
  type: 'added' | 'removed' | 'changed'
  changes?: { field: string; old: string; new: string }[]
}

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  readOnly?: boolean
}

export default function VersionPanel({ projectId, open, onClose, readOnly }: Props) {
  const dispatch = useAppDispatch()
  const { versions } = useAppSelector(s => s.versions)
  const { tasks, dependencies, comparison, diffFilter } = useAppSelector(s => s.tasks)
  const currentProject = useAppSelector(s => s.project.currentProject)

  const panelRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showAutosave, setShowAutosave] = useState(false)

  // Tab: 'versions' | 'changelog' | 'diff'
  const [activeTab, setActiveTab] = useState<'versions' | 'changelog' | 'diff'>('versions')

  // Changelog state
  const [changelogEvents, setChangelogEvents] = useState<TaskLifecycleEvent[]>([])
  const [changelogLoading, setChangelogLoading] = useState(false)
  const [changelogFrom, setChangelogFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7)
    return d.toISOString().split('T')[0]
  })
  const [changelogTo, setChangelogTo] = useState(() => new Date().toISOString().split('T')[0])

  // Diff state
  const [diffBaseId, setDiffBaseId] = useState<string | null>(null)
  const [diffCompareId, setDiffCompareId] = useState<string>('current')
  const [diffResult, setDiffResult] = useState<{ base: { name: string }; compare: { name: string }; diffs: DiffItem[]; stats: { added: number; removed: number; changed: number } } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // 加载版本列表
  const fetchVersions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch(`/api/versions/${projectId}?list=1`)
      const data = await res.json()
      if (data.ok && Array.isArray(data.value)) {
        dispatch(setVersions(data.value))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [projectId, dispatch])

  useEffect(() => {
    if (open) fetchVersions()
  }, [open, fetchVersions])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  // 创建快照
  const handleCreate = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await authFetch(`/api/versions/${projectId}`, {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({
          name: newName || undefined,
          description: newDesc || undefined,
          tasks, dependencies,
          status_date: currentProject?.status_date ?? null,
        }),
      })
      const data = await res.json()
      if (data.ok && data.value) {
        dispatch(addVersion(data.value))
        setNewName('')
        setNewDesc('')
        setShowCreate(false)
      } else {
        alert(data.error ?? '创建失败')
      }
    } catch {
      alert('网络错误')
    }
    setSaving(false)
  }, [projectId, tasks, dependencies, currentProject, newName, newDesc, saving, dispatch])

  // 重命名
  const handleRename = useCallback(async (v: ProjectVersion) => {
    try {
      const res = await authFetch(`/api/versions/${projectId}`, {
        method: 'PUT',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ id: v.id, name: editName, description: editDesc }),
      })
      const data = await res.json()
      if (data.ok) {
        dispatch(updateVersion({ id: v.id, name: editName, description: editDesc }))
        setEditingId(null)
      }
    } catch { /* ignore */ }
  }, [projectId, editName, editDesc, dispatch])

  // 删除
  const handleDelete = useCallback(async (v: ProjectVersion) => {
    if (!confirm(`确定删除「${v.name}」？此操作不可恢复。`)) return
    try {
      const res = await authFetch(`/api/versions/${projectId}`, {
        method: 'DELETE',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ id: v.id }),
      })
      const data = await res.json()
      if (data.ok) dispatch(removeVersion(v.id))
    } catch { /* ignore */ }
  }, [projectId, dispatch])

  // 查看：临时切换图表显示该版本快照，不影响当前工作状态，全局只读
  const handleView = useCallback(async (v: ProjectVersion) => {
    try {
      const res = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
      const data = await res.json()
      if (!data.ok || !data.value?.snapshot) {
        alert(data.error ?? '加载快照失败')
        return
      }
      const snap = data.value.snapshot
      const versionName = v.name || v.status_date?.split('T')[0] || `快照 #${v.version_number}`
      dispatch(setViewSnapshot({
        tasks: Array.isArray(snap.tasks) ? snap.tasks : [],
        dependencies: Array.isArray(snap.dependencies) ? snap.dependencies : [],
        versionId: v.id,
        versionName,
      }))
    } catch {
      alert('网络错误')
    }
  }, [projectId, dispatch])

  // 回退：仅本地预览，"保存版本"后才入库
  const handleRollback = useCallback(async (v: ProjectVersion) => {
    if (!confirm(`回退到「${v.name}」（本地预览）？\n\n当前所有未保存编辑会被覆盖。\n回退后需点"保存版本"才会真正入库；保存后自动生成新版本（递增 version_number），原有历史版本保留。`)) return
    try {
      const res = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
      const data = await res.json()
      if (!data.ok || !data.value?.snapshot) {
        alert(data.error ?? '加载快照失败')
        return
      }
      const snap = data.value.snapshot
      dispatch(setTasks({
        tasks: Array.isArray(snap.tasks) ? snap.tasks : [],
        dependencies: Array.isArray(snap.dependencies) ? snap.dependencies : [],
      }))
      alert(`已加载「${v.name}」到本地。点"保存版本"后入库。`)
    } catch {
      alert('网络错误')
    }
  }, [projectId, dispatch])

  // 在甘特图上对比：加载版本快照作为对比叠加层
  const handleCompareOnChart = useCallback(async (v: ProjectVersion) => {
    // 如果已在对比同一版本，则取消
    if (comparison?.versionName === (v.name || `快照 #${v.version_number}`)) {
      dispatch(clearComparison())
      return
    }
    try {
      const res = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
      const data = await res.json()
      if (data.ok && data.value?.snapshot?.tasks) {
        dispatch(setComparison({
          tasks: data.value.snapshot.tasks,
          versionName: v.name || `快照 #${v.version_number}`,
        }))
      }
    } catch { /* ignore */ }
  }, [projectId, dispatch, comparison])

  // 差异筛选：加载版本快照，计算 diff，筛选甘特图中变更的任务 + 显示基线条
  const handleDiffFilter = useCallback(async (v: ProjectVersion) => {
    const versionName = v.name || `快照 #${v.version_number}`
    // 如果已在筛选同一版本，则取消
    if (diffFilter?.versionName === versionName) {
      dispatch(clearDiffFilter())
      dispatch(clearComparison())
      return
    }
    try {
      const res = await authFetch(`/api/versions/${projectId}?id=${v.id}`)
      const data = await res.json()
      if (data.ok && data.value?.snapshot?.tasks) {
        const snapshotTasks = data.value.snapshot.tasks
        const oldTasks: SnapshotTask[] = snapshotTasks.map((t: Record<string, unknown>) => ({
          id: t.id, task_code: t.task_code, name: t.name,
          start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, assignee: t.assignee,
          percent_done: t.percent_done, is_milestone: t.is_milestone,
          parent_id: t.parent_id,
        }))
        const newTasks: SnapshotTask[] = tasks.filter(t => !t.is_deleted).map(t => ({
          id: t.id, task_code: t.task_code, name: t.name,
          start_date: t.start_date, end_date: t.end_date,
          duration: t.duration, assignee: t.assignee,
          percent_done: t.percent_done, is_milestone: t.is_milestone,
          parent_id: t.parent_id,
        }))
        const diffs = diffSnapshots(oldTasks, newTasks)
        const changedCodes = diffs.map(d => d.task_code)
        // 1. 筛选变更任务
        dispatch(setDiffFilter({ versionName, taskCodes: changedCodes }))
        // 2. 同时设置对比基线（显示旧版本的基线条）
        dispatch(setComparison({ tasks: snapshotTasks, versionName }))
      }
    } catch { /* ignore */ }
  }, [projectId, dispatch, tasks, diffFilter])

  // 加载变更记录
  const fetchChangelog = useCallback(async () => {
    setChangelogLoading(true)
    try {
      const res = await authFetch(`/api/tasks/${projectId}/changelog?from=${changelogFrom}&to=${changelogTo}`)
      const data = await res.json()
      if (data.ok) setChangelogEvents(data.value.events)
    } catch { /* ignore */ }
    setChangelogLoading(false)
  }, [projectId, changelogFrom, changelogTo])

  useEffect(() => {
    if (activeTab === 'changelog') fetchChangelog()
  }, [activeTab, fetchChangelog])

  // 版本对比
  const fetchDiff = useCallback(async () => {
    if (!diffBaseId) return
    setDiffLoading(true)
    try {
      const url = `/api/versions/${projectId}/diff?v1=${diffBaseId}` +
        (diffCompareId !== 'current' ? `&v2=${diffCompareId}` : '')
      const res = await authFetch(url)
      const data = await res.json()
      if (data.ok) setDiffResult(data.value)
    } catch { /* ignore */ }
    setDiffLoading(false)
  }, [projectId, diffBaseId, diffCompareId])

  useEffect(() => {
    if (activeTab === 'diff' && diffBaseId) fetchDiff()
  }, [activeTab, diffBaseId, diffCompareId, fetchDiff])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-300 rounded-lg shadow-xl"
      style={{ width: 480, maxHeight: 560 }}
    >
      {/* Header with tabs */}
      <div className="border-b border-gray-200">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round"/>
              <circle cx="5" cy="4" r="1.2" fill="currentColor" stroke="none"/>
              <circle cx="9" cy="8" r="1.2" fill="currentColor" stroke="none"/>
              <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/>
            </svg>
            <span className="text-[13px] font-semibold text-gray-800">版本管理</span>
          </div>
          {activeTab === 'versions' && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAutosave}
                  onChange={e => setShowAutosave(e.target.checked)}
                  className="accent-gray-400 w-3 h-3"
                />
                显示自动保存
              </label>
              <button
                onClick={() => setShowCreate(v => !v)}
                className="text-[12px] text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
              >
                + 创建快照
              </button>
            </div>
          )}
        </div>
        <div className="flex px-4 gap-1">
          {([
            { key: 'versions' as const, label: '快照', count: versions.length },
            { key: 'changelog' as const, label: '变更记录' },
            { key: 'diff' as const, label: '版本对比' },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-t border-b-2 cursor-pointer transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-500 text-blue-600 bg-blue-50/50'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
              {'count' in tab && tab.count != null && <span className="ml-1 text-gray-400">{tab.count}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ Tab: 快照 ═══ */}
      {activeTab === 'versions' && (
        <>
          {/* Create form */}
          {showCreate && (
            <div className="px-4 py-3 border-b border-gray-100 bg-blue-50/50">
              <input
                type="text"
                placeholder="快照名称（可选）"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-[12px] mb-2 focus:outline-none focus:border-blue-400"
              />
              <input
                type="text"
                placeholder="描述（可选）"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-[12px] mb-2 focus:outline-none focus:border-blue-400"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={saving}
                  className="px-3 py-1 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                >
                  {saving ? '保存中...' : '创建'}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName(''); setNewDesc('') }}
                  className="px-3 py-1 text-[12px] text-gray-500 hover:text-gray-700 cursor-pointer"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Version list */}
          <div className="overflow-y-auto" style={{ maxHeight: showCreate ? 330 : 430 }}>
            {loading && (
              <div className="py-8 text-center text-[12px] text-gray-400">加载中...</div>
            )}
            {!loading && versions.length === 0 && (
              <div className="py-8 text-center text-[12px] text-gray-400">暂无快照版本</div>
            )}
            {!loading && versions.filter(v => showAutosave || !v.is_autosave).map(v => (
              <div key={v.id} className={`border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors ${v.is_autosave ? 'bg-gray-50/60' : ''}`}>
                {editingId === v.id ? (
                  <div className="px-4 py-3">
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2.5 py-1 text-[12px] mb-1.5 focus:outline-none focus:border-blue-400"
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(v); if (e.key === 'Escape') setEditingId(null) }}
                    />
                    <input
                      type="text"
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      placeholder="描述"
                      className="w-full border border-gray-300 rounded px-2.5 py-1 text-[12px] mb-2 focus:outline-none focus:border-blue-400"
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(v); if (e.key === 'Escape') setEditingId(null) }}
                    />
                    <div className="flex gap-2">
                      <button onClick={() => handleRename(v)} className="px-2.5 py-0.5 text-[11px] bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer">保存</button>
                      <button onClick={() => setEditingId(null)} className="px-2.5 py-0.5 text-[11px] text-gray-500 hover:text-gray-700 cursor-pointer">取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[13px] font-medium ${v.is_autosave ? 'text-gray-500' : 'text-gray-800'}`}>{v.name || `快照 #${v.version_number}`}</span>
                        {v.is_autosave && <span className="text-[9px] px-1.5 py-0.5 bg-gray-200 text-gray-500 rounded font-medium">自动</span>}
                      </div>
                      <span className="text-[11px] text-gray-400">#{v.version_number}</span>
                    </div>
                    {v.description && (
                      <div className="text-[11px] text-gray-500 mb-1">{v.description}</div>
                    )}
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] text-gray-400">
                        {v.created_at ? new Date(v.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                        {v.task_count != null && <span className="ml-2">{v.task_count} 个任务</span>}
                        {v.status_date && <span className="ml-2">状态日期: {typeof v.status_date === 'string' ? v.status_date.split('T')[0] : v.status_date}</span>}
                        {v.changes?.stats && (
                          <span className="ml-2">
                            {v.changes.stats.added > 0 && <span className="text-green-600">+{v.changes.stats.added}</span>}
                            {v.changes.stats.changed > 0 && <span className="text-blue-600 ml-1">~{v.changes.stats.changed}</span>}
                            {v.changes.stats.removed > 0 && <span className="text-red-500 ml-1">-{v.changes.stats.removed}</span>}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleCompareOnChart(v)}
                          title="在甘特图上对比此版本"
                          className={`px-1.5 py-0.5 text-[10px] rounded cursor-pointer ${
                            comparison?.versionName === (v.name || `快照 #${v.version_number}`)
                              ? 'text-orange-700 bg-orange-100 font-semibold'
                              : 'text-orange-600 hover:bg-orange-50'
                          }`}
                        >
                          对比
                        </button>
                        <button
                          onClick={() => handleDiffFilter(v)}
                          title="在甘特图中筛选变更的任务"
                          className={`px-1.5 py-0.5 text-[10px] rounded cursor-pointer ${
                            diffFilter?.versionName === (v.name || `快照 #${v.version_number}`)
                              ? 'text-purple-700 bg-purple-100 font-semibold'
                              : 'text-purple-600 hover:bg-purple-50'
                          }`}
                        >
                          差异
                        </button>
                        <button
                          onClick={() => handleView(v)}
                          title="查看此版本（只读浏览，不影响工作状态）"
                          className="px-1.5 py-0.5 text-[10px] text-green-600 hover:bg-green-50 rounded cursor-pointer"
                        >
                          查看
                        </button>
                        {!readOnly && (
                        <button
                          onClick={() => handleRollback(v)}
                          title="回退到此版本（本地预览，保存版本后入库）"
                          className="px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50 rounded cursor-pointer"
                        >
                          回退
                        </button>
                        )}
                        {!readOnly && !v.is_autosave && (
                        <button
                          onClick={() => { setEditingId(v.id); setEditName(v.name); setEditDesc(v.description ?? '') }}
                          title="编辑"
                          className="px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 rounded cursor-pointer"
                        >
                          编辑
                        </button>
                        )}
                        {!readOnly && (
                        <button
                          onClick={() => handleDelete(v)}
                          title="删除"
                          className="px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-50 rounded cursor-pointer"
                        >
                          删除
                        </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ═══ Tab: 变更记录 ═══ */}
      {activeTab === 'changelog' && (
        <div className="flex flex-col" style={{ maxHeight: 430 }}>
          {/* Date range picker */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/50">
            <input type="date" value={changelogFrom} onChange={e => setChangelogFrom(e.target.value)}
                   className="border border-gray-300 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400" />
            <span className="text-[11px] text-gray-400">至</span>
            <input type="date" value={changelogTo} onChange={e => setChangelogTo(e.target.value)}
                   className="border border-gray-300 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400" />
            <button onClick={fetchChangelog}
                    className="px-2.5 py-1 text-[11px] bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer">
              查询
            </button>
          </div>

          {/* Events list */}
          <div className="overflow-y-auto flex-1">
            {changelogLoading && (
              <div className="py-8 text-center text-[12px] text-gray-400">加载中...</div>
            )}
            {!changelogLoading && changelogEvents.length === 0 && (
              <div className="py-8 text-center text-[12px] text-gray-400">该时段内无变更记录</div>
            )}
            {!changelogLoading && changelogEvents.map(ev => (
              <div key={ev.id} className="px-4 py-2 border-b border-gray-50 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    ev.event_type === 'created' ? 'bg-green-100 text-green-700' :
                    ev.event_type === 'deleted' ? 'bg-red-100 text-red-600' :
                    ev.event_type === 'moved' ? 'bg-purple-100 text-purple-600' :
                    'bg-blue-100 text-blue-600'
                  }`}>
                    {ev.event_type === 'created' ? '新建' :
                     ev.event_type === 'deleted' ? '删除' :
                     ev.event_type === 'moved' ? '移动' : '修改'}
                  </span>
                  <span className="text-[11px] font-medium text-gray-700">#{ev.task_code}</span>
                  <span className="text-[10px] text-gray-400 ml-auto">
                    {ev.created_by_name && <span className="mr-1.5">{ev.created_by_name}</span>}
                    {new Date(ev.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="text-[11px] text-gray-600">{ev.description}</div>
                {ev.field_name && ev.old_value != null && ev.new_value != null && (
                  <div className="mt-0.5 text-[10px] flex items-center gap-1">
                    <span className="text-red-500 line-through">{ev.old_value}</span>
                    <span className="text-gray-400">&rarr;</span>
                    <span className="text-green-600 font-medium">{ev.new_value}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Tab: 版本对比 ═══ */}
      {activeTab === 'diff' && (
        <div className="flex flex-col" style={{ maxHeight: 430 }}>
          {/* Version selectors */}
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/50 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 w-10 shrink-0">基准:</span>
              <select value={diffBaseId ?? ''} onChange={e => setDiffBaseId(e.target.value || null)}
                      className="flex-1 border border-gray-300 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400">
                <option value="">选择基准版本...</option>
                {versions.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name || `快照 #${v.version_number}`}
                    {' '}({v.created_at ? new Date(v.created_at).toLocaleDateString('zh-CN') : ''})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 w-10 shrink-0">对比:</span>
              <select value={diffCompareId} onChange={e => setDiffCompareId(e.target.value)}
                      className="flex-1 border border-gray-300 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400">
                <option value="current">当前工作版本</option>
                {versions.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name || `快照 #${v.version_number}`}
                    {' '}({v.created_at ? new Date(v.created_at).toLocaleDateString('zh-CN') : ''})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Diff results */}
          <div className="overflow-y-auto flex-1">
            {diffLoading && (
              <div className="py-8 text-center text-[12px] text-gray-400">对比中...</div>
            )}
            {!diffLoading && !diffBaseId && (
              <div className="py-8 text-center text-[12px] text-gray-400">请选择基准版本</div>
            )}
            {!diffLoading && diffResult && (
              <>
                {/* Stats bar */}
                <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 border-b border-gray-100">
                  <span className="text-[11px] text-gray-500">
                    {diffResult.base.name} &rarr; {diffResult.compare.name}
                  </span>
                  <div className="flex gap-2 ml-auto text-[10px]">
                    {diffResult.stats.added > 0 && <span className="text-green-600">+{diffResult.stats.added} 新增</span>}
                    {diffResult.stats.changed > 0 && <span className="text-blue-600">{diffResult.stats.changed} 修改</span>}
                    {diffResult.stats.removed > 0 && <span className="text-red-500">-{diffResult.stats.removed} 删除</span>}
                    {diffResult.diffs.length === 0 && <span className="text-gray-400">无差异</span>}
                  </div>
                </div>

                {/* Diff items */}
                {diffResult.diffs.map((d, i) => (
                  <div key={i} className="px-4 py-2 border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        d.type === 'added' ? 'bg-green-100 text-green-700' :
                        d.type === 'removed' ? 'bg-red-100 text-red-600' :
                        'bg-blue-100 text-blue-600'
                      }`}>
                        {d.type === 'added' ? '新增' : d.type === 'removed' ? '删除' : '修改'}
                      </span>
                      <span className="text-[11px] font-medium text-gray-700">#{d.task_code}</span>
                      <span className="text-[11px] text-gray-500">{d.task_name}</span>
                    </div>
                    {d.changes && d.changes.length > 0 && (
                      <div className="mt-1 space-y-0.5 ml-4">
                        {d.changes.map((c, j) => (
                          <div key={j} className="text-[10px] flex items-center gap-1.5">
                            <span className="text-gray-500 w-12 shrink-0">{c.field}:</span>
                            <span className="text-red-500 line-through">{c.old}</span>
                            <span className="text-gray-400">&rarr;</span>
                            <span className="text-green-600 font-medium">{c.new}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
