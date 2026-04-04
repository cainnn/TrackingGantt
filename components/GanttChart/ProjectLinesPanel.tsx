'use client'

import React, { useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addProjectLine, updateProjectLine, removeProjectLine,
} from '@/store/slices/projectLinesSlice'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import type { ProjectLine } from '@/types'

const PRESET_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280']

interface Props {
  projectId: string
  onClose: () => void
}

export default function ProjectLinesPanel({ projectId, onClose }: Props) {
  const dispatch = useAppDispatch()
  const lines = useAppSelector(s => s.projectLines.lines)

  const [newName, setNewName] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newColor, setNewColor] = useState('#f59e0b')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editColor, setEditColor] = useState('#f59e0b')

  const handleAdd = async () => {
    if (!newName.trim() || !newDate) return
    const res = await authFetch(`/api/project-lines/${projectId}`, {
      method: 'POST',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ name: newName.trim(), line_date: newDate, color: newColor }),
    })
    const data = await res.json()
    if (data.ok) {
      dispatch(addProjectLine(data.value))
      setNewName('')
      setNewDate('')
      setNewColor('#f59e0b')
    }
  }

  const handleToggleVisible = async (line: ProjectLine) => {
    const newVisible = !line.visible
    dispatch(updateProjectLine({ ...line, visible: newVisible }))
    await authFetch(`/api/project-lines/${projectId}`, {
      method: 'PUT',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ id: line.id, visible: newVisible }),
    })
  }

  const handleDelete = async (id: string) => {
    dispatch(removeProjectLine(id))
    await authFetch(`/api/project-lines/${projectId}`, {
      method: 'DELETE',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ id }),
    })
  }

  const startEdit = (line: ProjectLine) => {
    setEditId(line.id)
    setEditName(line.name)
    setEditDate(line.line_date?.split('T')[0] ?? '')
    setEditColor(line.color)
  }

  const handleSaveEdit = async () => {
    if (!editId || !editName.trim() || !editDate) return
    const res = await authFetch(`/api/project-lines/${projectId}`, {
      method: 'PUT',
      headers: authFetchHeaders(true),
      body: JSON.stringify({ id: editId, name: editName.trim(), line_date: editDate, color: editColor }),
    })
    const data = await res.json()
    if (data.ok) {
      dispatch(updateProjectLine(data.value))
      setEditId(null)
    }
  }

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">项目线管理</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
      </div>

      {/* Add new line */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          placeholder="名称"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          className="border border-gray-300 rounded px-2 h-7 text-[13px] w-28 focus:outline-none focus:border-blue-400"
        />
        <input
          type="date"
          value={newDate}
          onChange={e => setNewDate(e.target.value)}
          className="border border-gray-300 rounded px-2 h-7 text-[13px] focus:outline-none focus:border-blue-400"
        />
        <div className="flex items-center gap-1">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              onClick={() => setNewColor(c)}
              className={`w-5 h-5 rounded-full border-2 ${newColor === c ? 'border-gray-800' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <button
          onClick={handleAdd}
          disabled={!newName.trim() || !newDate}
          className="px-3 h-7 rounded border border-green-400 text-green-600 text-[13px] font-medium
                     hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          添加
        </button>
      </div>

      {/* List */}
      {lines.length === 0 ? (
        <p className="text-xs text-gray-400">暂无项目线</p>
      ) : (
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {lines.map(line => (
            <div key={line.id} className="flex items-center gap-2 text-[13px] py-1">
              {editId === line.id ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="border border-gray-300 rounded px-2 h-6 text-[12px] w-24 focus:outline-none focus:border-blue-400"
                  />
                  <input
                    type="date"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    className="border border-gray-300 rounded px-2 h-6 text-[12px] focus:outline-none focus:border-blue-400"
                  />
                  <div className="flex items-center gap-0.5">
                    {PRESET_COLORS.map(c => (
                      <button
                        key={c}
                        onClick={() => setEditColor(c)}
                        className={`w-4 h-4 rounded-full border-2 ${editColor === c ? 'border-gray-800' : 'border-transparent'}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <button onClick={handleSaveEdit} className="text-blue-600 hover:text-blue-800 text-xs">保存</button>
                  <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600 text-xs">取消</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => handleToggleVisible(line)}
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      line.visible ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-300 bg-white'
                    }`}
                  >
                    {line.visible && (
                      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2 6l3 3 5-5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                  <span
                    className="w-3 h-3 rounded-full inline-block flex-shrink-0"
                    style={{ backgroundColor: line.color }}
                  />
                  <span className="text-gray-700 min-w-[60px]">{line.name}</span>
                  <span className="text-gray-400 text-xs">{line.line_date?.split('T')[0]}</span>
                  <button onClick={() => startEdit(line)} className="text-blue-500 hover:text-blue-700 text-xs ml-auto">编辑</button>
                  <button onClick={() => handleDelete(line.id)} className="text-red-400 hover:text-red-600 text-xs">删除</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
