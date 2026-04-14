'use client'

import { useState, useEffect, useCallback } from 'react'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'

interface UserRow {
  id: string
  username: string
  email: string
  role: string
  created_at: string
}

const ROLE_LABELS: Record<string, string> = {
  administrator: '超级管理员',
  admin: '管理员',
  view: '只读',
}

export default function UserManagement() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [creating, setCreating] = useState(false)

  // Password change
  const [editingPwdId, setEditingPwdId] = useState<string | null>(null)
  const [newPwd, setNewPwd] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)

  const fetchUsers = useCallback(async () => {
    try {
      const res = await authFetch('/api/users')
      const data = await res.json()
      if (data.ok) setUsers(data.value)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!newUsername.trim() || !newEmail.trim() || !newPassword) return
    setCreating(true)
    try {
      const res = await authFetch('/api/users', {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ username: newUsername.trim(), email: newEmail.trim(), password: newPassword }),
      })
      const data = await res.json()
      if (data.ok) {
        setUsers(prev => [...prev, data.value])
        setNewUsername(''); setNewEmail(''); setNewPassword('')
        setShowCreate(false)
      } else {
        setError(data.error ?? '创建失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally { setCreating(false) }
  }

  const handleDelete = async (u: UserRow) => {
    if (!confirm(`确定删除用户「${u.username}」？该操作不可恢复。`)) return
    try {
      const res = await authFetch('/api/users', {
        method: 'DELETE',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ userId: u.id }),
      })
      const data = await res.json()
      if (data.ok) {
        setUsers(prev => prev.filter(x => x.id !== u.id))
      } else {
        alert(data.error ?? '删除失败')
      }
    } catch { alert('删除失败') }
  }

  const handleChangePwd = async (userId: string) => {
    if (!newPwd || newPwd.length < 6) { alert('密码长度不能少于6位'); return }
    setSavingPwd(true)
    try {
      const res = await authFetch('/api/users', {
        method: 'PUT',
        headers: authFetchHeaders(true),
        body: JSON.stringify({ userId, password: newPwd }),
      })
      const data = await res.json()
      if (data.ok) {
        setEditingPwdId(null); setNewPwd('')
        alert('密码已更新')
      } else {
        alert(data.error ?? '修改失败')
      }
    } catch { alert('修改失败') }
    finally { setSavingPwd(false) }
  }

  if (loading) return <div className="text-gray-500 text-sm py-4">加载中...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800">用户管理</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          + 新建用户
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 text-red-700 p-3 rounded text-sm">{error}</div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-4 p-4 bg-white rounded-lg border border-gray-200 shadow-sm space-y-3">
          <div className="text-sm font-medium text-gray-700 mb-1">创建新用户（admin 类型）</div>
          <div className="grid grid-cols-3 gap-2">
            <input
              autoFocus
              type="text"
              placeholder="用户名"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="email"
              placeholder="邮箱"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              placeholder="密码（至少6位）"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? '创建中...' : '创建'}
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); setError(null) }}
              className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
            >
              取消
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium text-gray-600">用户名</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-600">邮箱</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-600">角色</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-600">创建时间</th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5 font-medium text-gray-900">{u.username}</td>
                <td className="px-4 py-2.5 text-gray-600">{u.email}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    u.role === 'administrator' ? 'bg-purple-100 text-purple-700'
                    : u.role === 'admin' ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>
                    {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-500">
                  {new Date(u.created_at).toLocaleDateString('zh-CN')}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {u.role !== 'administrator' && (
                    <div className="flex items-center justify-end gap-2">
                      {editingPwdId === u.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            type="text"
                            placeholder="新密码"
                            value={newPwd}
                            onChange={e => setNewPwd(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleChangePwd(u.id); if (e.key === 'Escape') { setEditingPwdId(null); setNewPwd('') } }}
                            className="border border-gray-300 rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <button
                            onClick={() => handleChangePwd(u.id)}
                            disabled={savingPwd}
                            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                          >
                            确定
                          </button>
                          <button
                            onClick={() => { setEditingPwdId(null); setNewPwd('') }}
                            className="text-xs text-gray-500 hover:text-gray-700"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => { setEditingPwdId(u.id); setNewPwd('') }}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            改密码
                          </button>
                          <button
                            onClick={() => handleDelete(u)}
                            className="text-xs text-red-600 hover:text-red-800"
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
