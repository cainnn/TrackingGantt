'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setProjects, addProject } from '@/store/slices/projectSlice'
import ProjectCard from '@/components/ProjectCard'
import { logout } from '@/store/slices/authSlice'

export default function DashboardPage() {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const { user } = useAppSelector(s => s.auth)
  const { projects } = useAppSelector(s => s.project)
  const [creating, setCreating] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      router.push('/login')
      return
    }
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        if (data.ok) dispatch(setProjects(data.value))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user, dispatch, router])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newProjectName.trim()) return

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newProjectName,
        start_date: new Date().toISOString().split('T')[0],
      }),
    })
    const data = await res.json()
    if (data.ok) {
      dispatch(addProject(data.value))
      setNewProjectName('')
      setCreating(false)
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
        <h1 className="text-xl font-bold text-gray-900">甘特图管理</h1>
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
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            + 新建项目
          </button>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="mb-6 flex gap-2">
            <input
              autoFocus
              type="text"
              placeholder="项目名称"
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
            >
              创建
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
            >
              取消
            </button>
          </form>
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
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
