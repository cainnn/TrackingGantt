'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setProjects, addProject, deleteProject } from '@/store/slices/projectSlice'
import ProjectCard from '@/components/ProjectCard'
import { logout } from '@/store/slices/authSlice'
import { authFetch } from '@/lib/client/authFetch'
import UserManagement from '@/components/UserManagement'

export default function DashboardPage() {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const { user, token } = useAppSelector(s => s.auth)
  const isViewOnly = user?.role === 'view'
  const isAdministrator = user?.role === 'administrator'
  const { projects } = useAppSelector(s => s.project)
  const [activeTab, setActiveTab] = useState<'projects' | 'users'>('projects')
  const [creating, setCreating] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newGranularity, setNewGranularity] = useState<'day' | 'minute'>('day')
  const [copyFrom, setCopyFrom] = useState('')
  const [loading, setLoading] = useState(true)
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelectedIds(new Set(projects.map(p => p.id)))
  const invertSelect = () => setSelectedIds(prev => {
    const next = new Set<string>()
    for (const p of projects) if (!prev.has(p.id)) next.add(p.id)
    return next
  })
  const clearSelect = () => setSelectedIds(new Set())
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`确定删除选中的 ${selectedIds.size} 个项目？此操作不可撤销。`)) return
    setBulkDeleting(true)
    try {
      const ids = Array.from(selectedIds)
      const results = await Promise.allSettled(ids.map(id =>
        authFetch(`/api/projects/${id}`, { method: 'DELETE' }).then(r => r.json()).then(d => ({ id, ok: d.ok }))
      ))
      const okIds: string[] = []
      const failed: string[] = []
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) okIds.push(r.value.id)
        else failed.push(r.status === 'fulfilled' ? r.value.id : '?')
      }
      okIds.forEach(id => dispatch(deleteProject(id)))
      setSelectedIds(new Set())
      if (failed.length > 0) alert(`${failed.length} 个项目删除失败`)
    } finally {
      setBulkDeleting(false)
    }
  }

  useEffect(() => {
    if (!user) {
      router.push('/login')
      return
    }
    authFetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        if (data.ok) dispatch(setProjects(data.value))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user, token, dispatch, router])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError(null)
    if (!newProjectName.trim()) return

    setCreateLoading(true)
    try {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      // 分钟级项目默认从今天早上 09:00 开始；天级仍为日期串
      const startDefault = newGranularity === 'minute' ? `${today}T09:00:00` : today
      const payload: Record<string, string> = {
        name: newProjectName,
        start_date: startDefault,
        time_granularity: newGranularity,
      }
      if (copyFrom) payload.copy_from = copyFrom
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      const data = (text ? JSON.parse(text) : {}) as { ok?: boolean; value?: unknown; error?: string; code?: number }

      if (!res.ok || !data.ok) {
        if (res.status === 401 || data.code === 401) {
          router.push('/login')
          return
        }
        setCreateError(data.error ?? `创建失败（${res.status}）`)
        return
      }

      dispatch(addProject(data.value as any))
      setNewProjectName('')
      setCopyFrom('')
      setNewGranularity('day')
      setCreating(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreateLoading(false)
    }
  }

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    dispatch(logout())
    router.push('/login')
  }

  if (!user) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">跟踪甘特图</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">你好，{user.username}</span>
          <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-700">
            退出登录
          </button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        {isAdministrator && (
          <div className="flex gap-1 mb-6 border-b border-gray-200">
            <button
              onClick={() => setActiveTab('projects')}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'projects'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              项目管理
            </button>
            <button
              onClick={() => setActiveTab('users')}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'users'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              用户管理
            </button>
          </div>
        )}

        {activeTab === 'users' && isAdministrator ? (
          <UserManagement />
        ) : (
        <>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800">我的项目</h2>
          {!isViewOnly && (
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            + 新建项目
          </button>
          )}
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="mb-6 p-4 bg-white rounded-lg border border-gray-200 shadow-sm space-y-3">
            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                placeholder="项目名称"
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600 flex-none">复制自：</label>
              <select
                value={copyFrom}
                onChange={e => setCopyFrom(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">不复制（空项目）</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            {copyFrom && (
              <p className="text-xs text-gray-500">将复制选中项目的所有任务和依赖关系到新项目（精度跟随源项目）</p>
            )}
            {!copyFrom && (
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 flex-none">时间精度：</label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="granularity"
                    value="day"
                    checked={newGranularity === 'day'}
                    onChange={() => setNewGranularity('day')}
                    className="accent-blue-500"
                  />
                  <span>天级（YYYY-MM-DD，日历日）</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="granularity"
                    value="minute"
                    checked={newGranularity === 'minute'}
                    onChange={() => setNewGranularity('minute')}
                    className="accent-blue-500"
                  />
                  <span>分钟级（YYYY-MM-DD HH:mm，15min 吸附）</span>
                </label>
              </div>
            )}
            {!copyFrom && (
              <p className="text-xs text-gray-400">创建后不可更改。短期项目建议分钟级；长期排期建议天级。</p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createLoading}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
              >
                {createLoading ? '创建中...' : '创建'}
              </button>
              <button
                type="button"
                onClick={() => { setCreating(false); setCopyFrom('') }}
                className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
              >
                取消
              </button>
            </div>
          </form>
        )}

        {creating && createError && (
          <div className="mb-6 bg-red-50 text-red-700 p-3 rounded text-sm">{createError}</div>
        )}

        {loading ? (
          <div className="text-center text-gray-500 py-12">加载中...</div>
        ) : projects.length === 0 ? (
          <div className="text-center text-gray-500 py-12">
            暂无项目，点击「新建项目」开始
          </div>
        ) : (
          <>
            {!isViewOnly && (
              <div className="mb-3 flex items-center gap-2 text-sm">
                <button
                  onClick={selectAll}
                  className="px-3 py-1.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-100"
                >全选</button>
                <button
                  onClick={invertSelect}
                  className="px-3 py-1.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-100"
                >反选</button>
                <button
                  onClick={clearSelect}
                  disabled={selectedIds.size === 0}
                  className="px-3 py-1.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >清空</button>
                <button
                  onClick={handleBulkDelete}
                  disabled={selectedIds.size === 0 || bulkDeleting}
                  className="px-3 py-1.5 border border-red-300 rounded text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {bulkDeleting ? '删除中...' : `批量删除 (${selectedIds.size})`}
                </button>
                <span className="text-xs text-gray-500 ml-auto">
                  已选 {selectedIds.size} / {projects.length}
                </span>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  readOnly={isViewOnly}
                  selected={selectedIds.has(p.id)}
                  onToggleSelect={() => toggleSelect(p.id)}
                />
              ))}
            </div>
          </>
        )}
        </>
        )}
      </main>
    </div>
  )
}
