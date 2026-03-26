'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAppDispatch } from '@/store/hooks'
import { deleteProject, updateProject } from '@/store/slices/projectSlice'
import type { Project } from '@/types'

interface ProjectCardProps {
  project: Project
}

export default function ProjectCard({ project }: ProjectCardProps) {
  const dispatch = useAppDispatch()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const [loading, setLoading] = useState(false)

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault()
    if (!confirm(`确定删除项目「${project.name}」？`)) return

    const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.ok) {
      dispatch(deleteProject(project.id))
    }
  }

  const handleEdit = () => {
    setEditName(project.name)
    setEditing(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editName.trim()) return

    setLoading(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        dispatch(updateProject({ ...project, name: editName.trim() }))
        setEditing(false)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    setEditName(project.name)
    setEditing(false)
  }

  const progress = project.progress ?? 0
  const progressColor = progress >= 80 ? 'text-green-600' : progress >= 50 ? 'text-blue-600' : progress >= 20 ? 'text-yellow-600' : 'text-gray-600'

  return (
    <div className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow bg-white">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          {editing ? (
            <form onSubmit={handleSave} className="flex items-center gap-2 mb-2">
              <input
                autoFocus
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
              <button
                type="submit"
                className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                disabled={loading || !editName.trim()}
              >
                保存
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-2 py-1 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300"
                disabled={loading}
              >
                取消
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-2 mb-2">
              <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 hover:text-blue-600 truncate">
                  {project.name}
                </h3>
              </Link>
              <button
                onClick={handleEdit}
                className="text-gray-400 hover:text-blue-600 text-xs"
                title="重命名"
              >
                ✎
              </button>
            </div>
          )}
          <div className="text-sm text-gray-500 space-y-1">
            {project.start_date && (
              <p>开始：{new Date(project.start_date).toLocaleDateString('zh-CN')}</p>
            )}
            {project.status_date && (
              <p className="text-blue-600">
                状态日期：{new Date(project.status_date).toLocaleDateString('zh-CN')}
              </p>
            )}
            <p className={`font-semibold ${progressColor}`}>
              进度：{progress}%
            </p>
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="ml-2 text-gray-400 hover:text-red-600 text-sm"
          title="删除项目"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
