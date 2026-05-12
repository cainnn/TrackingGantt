'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAppDispatch } from '@/store/hooks'
import { deleteProject, updateProject } from '@/store/slices/projectSlice'
import { authFetch } from '@/lib/client/authFetch'
import type { Project } from '@/types'

interface ProjectCardProps {
  project: Project
  readOnly?: boolean
}

export default function ProjectCard({ project, readOnly }: ProjectCardProps) {
  const dispatch = useAppDispatch()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const [loading, setLoading] = useState(false)

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault()
    if (!confirm(`确定删除项目「${project.name}」？`)) return

    const res = await authFetch(`/api/projects/${project.id}`, { method: 'DELETE' })
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
      const res = await authFetch(`/api/projects/${project.id}`, {
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
              <Link href={`/projects/${project.id}`} className="flex-1 min-w-0 flex items-center gap-1.5">
                <h3 className="font-semibold text-gray-900 hover:text-blue-600 truncate">
                  {project.name}
                </h3>
                {project.time_granularity === 'minute' && (
                  <span className="flex-none text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200">
                    分钟级
                  </span>
                )}
              </Link>
              {!readOnly && (
              <button
                onClick={handleEdit}
                className="text-gray-400 hover:text-blue-600 text-xs"
                title="重命名"
              >
                ✎
              </button>
              )}
            </div>
          )}
          <div className="text-sm text-gray-500 space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-gray-500">开始：</span>
              {(() => {
                const isMinute = project.time_granularity === 'minute'
                const sliceLen = isMinute ? 16 : 10
                const ctlType = isMinute ? 'datetime-local' : 'date'
                const ctlVal = (project.start_date ?? '').slice(0, sliceLen)
                const dispVal = isMinute ? ctlVal.replace('T', ' ') : ctlVal
                if (readOnly) return <span className="text-gray-700 text-xs">{dispVal}</span>
                return (
                  <input
                    type={ctlType}
                    step={isMinute ? 60 * 15 : undefined}
                    value={ctlVal}
                    onChange={async e => {
                      const val = e.target.value || null
                      const res = await authFetch(`/api/projects/${project.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ start_date: val }),
                      })
                      const data = await res.json()
                      if (data.ok) dispatch(updateProject({ ...project, start_date: val }))
                    }}
                    className={`border border-gray-200 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-blue-400 text-gray-700 ${isMinute ? 'w-[160px]' : ''}`}
                  />
                )
              })()}
            </div>
            {project.estimated_end_date && (
              <div className="flex items-center gap-1">
                <span className="text-gray-500">预计完成：</span>
                <span className="text-gray-700 text-xs font-medium">
                  {project.time_granularity === 'minute'
                    ? project.estimated_end_date.slice(0, 16).replace('T', ' ')
                    : project.estimated_end_date.slice(0, 10)}
                </span>
              </div>
            )}
            {project.status_date && (
              <p className="text-blue-600">
                状态日期：{project.time_granularity === 'minute'
                  ? project.status_date.slice(0, 16).replace('T', ' ')
                  : new Date(project.status_date).toLocaleDateString('zh-CN')}
              </p>
            )}
            <p className={`font-semibold ${progressColor}`}>
              进度：{progress}%
            </p>
          </div>
        </div>
        {!readOnly && (
        <button
          onClick={handleDelete}
          className="ml-2 text-gray-400 hover:text-red-600 text-sm"
          title="删除项目"
        >
          ✕
        </button>
        )}
      </div>
    </div>
  )
}
