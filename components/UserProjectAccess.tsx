'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'

interface AccessUser { id: string; username: string; role: string }
interface AccessProject { id: string; name: string; user_id: string; creator_name: string; member_ids: string[] }
type DragItem = { type: 'project' | 'user'; id: string }
const DRAG_TYPE = 'application/x-gantt-association'

export default function UserProjectAccess({ users }: { users: AccessUser[] }) {
  const [projects, setProjects] = useState<AccessProject[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const dragItem = useRef<DragItem | null>(null)
  const [dropTarget, setDropTarget] = useState('')
  const selectedUser = users.find(u => u.id === selectedId) ?? users.find(u => u.role !== 'administrator') ?? users[0]
  const isAdministrator = selectedUser?.role === 'administrator'

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await authFetch('/api/users/projects')
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error ?? '加载项目关联失败')
      setProjects(data.value)
    } catch (error) { setError(error instanceof Error ? error.message : '加载项目关联失败') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void loadProjects() }, [loadProjects])

  async function associate(userId: string, projectId: string, linked: boolean) {
    if (savingRef.current || loading) return
    const user = users.find(u => u.id === userId)
    const project = projects.find(p => p.id === projectId)
    if (!user || !project || user.role === 'administrator' || project.member_ids.includes(userId) === linked) return
    savingRef.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await authFetch('/api/users/projects', {
        method: linked ? 'POST' : 'DELETE', headers: authFetchHeaders(true),
        body: JSON.stringify({ userId, projectId }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error ?? '保存项目关联失败')
      setProjects(previous => previous.map(p => p.id !== projectId ? p : {
        ...p, member_ids: linked ? [...new Set([...p.member_ids, userId])] : p.member_ids.filter(id => id !== userId),
      }))
      setNotice(linked ? `已将「${project.name}」关联给 ${user.username}` : `已移除 ${user.username} 对「${project.name}」的访问权限`)
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试') }
    finally { savingRef.current = false; setSaving(false) }
  }

  function startDrag(event: DragEvent, item: DragItem) {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
    event.dataTransfer.effectAllowed = 'copyMove'
    dragItem.current = item
    setNotice('')
  }
  function endDrag() { dragItem.current = null; setDropTarget('') }
  function readDrop(event: DragEvent): DragItem | null {
    event.preventDefault()
    endDrag()
    try {
      const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE))
      return (item?.type === 'user' || item?.type === 'project') && typeof item.id === 'string' ? item : null
    } catch { return null }
  }
  function allowDrop(event: DragEvent, target: string, allowed: boolean) {
    if (!allowed || saving || loading) return
    event.preventDefault()
    event.dataTransfer.dropEffect = target.startsWith('column:') ? 'move' : 'copy'
    setDropTarget(target)
  }

  const visibleProjects = projects.filter(p => p.name.toLowerCase().includes(projectSearch.trim().toLowerCase()))
  const linkedCount = projects.filter(p => isAdministrator || p.member_ids.includes(selectedUser?.id ?? '')).length
  const canEdit = Boolean(selectedUser && !isAdministrator && !saving && !loading)

  function projectCard(project: AccessProject, linked: boolean) {
    return (
      <article key={project.id} data-project-id={project.id}
        draggable={!saving && !loading}
        onDragStart={event => startDrag(event, { type: 'project', id: project.id })}
        onDragEnd={endDrag}
        onDragOver={event => {
          if (dragItem.current?.type !== 'user') return
          event.stopPropagation()
          allowDrop(event, `project:${project.id}`, true)
        }}
        onDrop={event => {
          if (dragItem.current?.type !== 'user') return
          event.stopPropagation()
          const item = readDrop(event)
          if (item?.type === 'user') { setSelectedId(item.id); void associate(item.id, project.id, true) }
        }}
        className={`rounded-lg border bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing ${dropTarget === `project:${project.id}` ? 'border-blue-500 ring-2 ring-blue-100' : 'border-gray-200'}`}>
        <div className="flex items-start gap-2">
          <span className="select-none text-gray-400" aria-hidden="true">⠿</span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium text-gray-900">{project.name}</p>
            <p className="mt-1 text-xs text-gray-500">创建人：{project.creator_name}</p>
          </div>
          {!isAdministrator && <button type="button" disabled={!canEdit}
            onClick={() => selectedUser && void associate(selectedUser.id, project.id, !linked)}
            aria-label={`${linked ? '移除' : '关联'}项目 ${project.name}`}
            className={`shrink-0 rounded px-2 py-1 text-xs disabled:opacity-40 ${linked ? 'text-red-600 hover:bg-red-50' : 'text-blue-600 bg-blue-50 hover:bg-blue-100'}`}>
            {linked ? '移除' : '关联'}
          </button>}
        </div>
      </article>
    )
  }

  return (
    <section aria-label="用户与项目关联" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">分配项目访问权限</h3>
          <p className="mt-1 text-sm text-gray-500">将项目拖到用户上，或将用户拖到项目上，即可关联。也可点击按钮操作。</p>
          <p className="mt-1 text-xs text-gray-500">新项目自动关联创建人；同一项目可关联多个用户。移除关联会撤销访问权限，项目内容与创建人记录保留。</p>
        </div>
        <button onClick={() => void loadProjects()} disabled={saving || loading}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40">刷新关联</button>
      </div>
      {error && <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <p role="status" aria-live="polite" className={`min-h-5 text-sm ${saving ? 'text-gray-500' : 'text-green-700'}`}>{saving ? '正在保存关联…' : notice}</p>
      <div className="grid items-start gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="rounded-xl border border-gray-200 bg-white p-3">
          <label htmlFor="association-user-search" className="mb-2 block text-sm font-medium text-gray-700">用户 · {users.length}</label>
          <input id="association-user-search" value={userSearch} onChange={e => setUserSearch(e.target.value)} placeholder="搜索用户"
            className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <div className="max-h-[560px] space-y-1 overflow-y-auto">
            {users.filter(u => u.username.toLowerCase().includes(userSearch.trim().toLowerCase())).map(user => {
              const admin = user.role === 'administrator'
              const count = admin ? projects.length : projects.filter(p => p.member_ids.includes(user.id)).length
              return <button key={user.id} type="button" data-user-id={user.id} title={user.username} aria-pressed={selectedUser?.id === user.id}
                draggable={!admin && !saving && !loading}
                onDragStart={event => startDrag(event, { type: 'user', id: user.id })} onDragEnd={endDrag}
                onDragOver={event => allowDrop(event, `user:${user.id}`, !admin && dragItem.current?.type === 'project')}
                onDragLeave={() => setDropTarget('')}
                onDrop={event => {
                  const item = readDrop(event)
                  if (item?.type === 'project' && !admin) { setSelectedId(user.id); void associate(user.id, item.id, true) }
                }}
                onClick={() => setSelectedId(user.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${dropTarget === `user:${user.id}` ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-100' : selectedUser?.id === user.id ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:bg-gray-50'}`}>
                <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-gray-900">{user.username}</span><span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{loading ? '…' : count} 项目</span></span>
                <span className="mt-1 block text-xs text-gray-500">{admin ? '超级管理员 · 全部项目' : user.role === 'view' ? '只读用户' : '普通用户 · 可编辑'}</span>
              </button>
            })}
          </div>
        </aside>
        <div className="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h4 className="font-semibold text-gray-900">{selectedUser?.username ?? '选择一个用户'}</h4>
              <p className="mt-1 text-xs text-gray-500">{isAdministrator ? '超级管理员始终可以访问全部项目，无需单独关联。' : `已关联 ${linkedCount} 个项目 · 拖动项目到另一栏可添加或移除关联`}</p></div>
            <input aria-label="搜索项目" placeholder="搜索项目" value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm sm:w-52" />
          </div>
          {loading ? <p className="py-16 text-center text-sm text-gray-500">加载项目关联中…</p> : (
            <div className={`grid gap-4 ${isAdministrator ? '' : 'md:grid-cols-2'}`}>
              {(isAdministrator ? [true] : [false, true]).map(linked => {
                const list = visibleProjects.filter(p => (isAdministrator || p.member_ids.includes(selectedUser?.id ?? '')) === linked)
                return <div key={String(linked)} data-association-column={linked ? 'linked' : 'unlinked'}
                  onDragOver={event => allowDrop(event, `column:${linked}`, canEdit && dragItem.current?.type === 'project')}
                  onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget('') }}
                  onDrop={event => {
                    const item = readDrop(event)
                    if (item?.type === 'project' && selectedUser && canEdit) void associate(selectedUser.id, item.id, linked)
                  }}
                  className={`min-h-64 rounded-lg border-2 border-dashed p-3 ${dropTarget === `column:${linked}` ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
                  <h5 className="mb-3 text-sm font-medium text-gray-700">{isAdministrator ? '全部项目' : linked ? '已关联' : '未关联'} <span className="text-gray-400">{list.length}</span></h5>
                  <div className="max-h-[520px] space-y-2 overflow-y-auto">{list.map(p => projectCard(p, linked))}</div>
                  {!list.length && <p className="py-12 text-center text-xs text-gray-400">{projectSearch ? '没有匹配的项目' : linked ? '拖动项目到这里进行关联' : '拖动已关联项目到这里移除权限'}</p>}
                </div>
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
