'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setProjects, addProject } from '@/store/slices/projectSlice'
import ProjectCard from '@/components/ProjectCard'
import { logout } from '@/store/slices/authSlice'
import { authFetch } from '@/lib/client/authFetch'

export default function DashboardPage() {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const { user, token } = useAppSelector(s => s.auth)
  const isViewOnly = user?.role === 'view'
  const { projects } = useAppSelector(s => s.project)
  const [creating, setCreating] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [loading, setLoading] = useState(true)
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

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
      const payload: Record<string, string> = {
        name: newProjectName,
        start_date: new Date().toISOString().split('T')[0],
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
              <p className="text-xs text-gray-500">将复制选中项目的所有任务和依赖关系到新项目</p>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map(p => (
              <ProjectCard key={p.id} project={p} readOnly={isViewOnly} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
