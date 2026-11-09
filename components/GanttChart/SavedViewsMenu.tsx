'use client'
import { useEffect, useState } from 'react'
import type { SavedGanttView } from '@/lib/clientViewState'
import type { useProjectViews } from '@/lib/client/useProjectViews'
import { uuid } from '@/lib/uuid'

export default function SavedViewsMenu({ projectId, capture, apply, layouts }: {
  projectId: string
  capture: () => Omit<SavedGanttView, 'id' | 'name'> | null
  apply: (view: SavedGanttView) => void
  layouts: ReturnType<typeof useProjectViews>
}) {
  const { preferences, loading, saving, readOnly, persist } = layouts
  const views = preferences?.views ?? []
  const [selected, setSelected] = useState(() => views.some(v => v.id === preferences?.currentView?.id) ? preferences!.currentView!.id : '')
  const [error, setError] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const currentViewId = preferences?.currentView?.id
  useEffect(() => {
    setSelected(currentViewId && views.some(v => v.id === currentViewId) ? currentViewId : '')
  }, [currentViewId])
  const disabled = loading || saving || readOnly || !preferences
  const save = async (kind: 'current' | 'new' | 'update') => {
    if (disabled) return
    setError('')
    const value = capture()
    if (!value) { setError('图表尚未准备好，请稍后重试'); return }
    if (kind === 'new' && !name.trim()) return
    if (kind === 'new' && views.length >= 20) { setError('最多保存 20 个布局，请先删除不用的布局'); return }
    const previous = views.find(v => v.id === selected)
    if (kind === 'update' && !previous) return
    const view: SavedGanttView = { ...value,
      id: kind === 'new' ? uuid() : kind === 'update' ? previous!.id : 'current',
      name: kind === 'new' ? name.trim().slice(0, 60) : kind === 'update' ? previous!.name : '项目布局',
    }
    const nextViews = kind === 'new' ? [...views, view] : kind === 'update' ? views.map(v => v.id === view.id ? view : v) : views
    if (await persist({ ...preferences, currentView: view, views: nextViews })) {
      setSelected(kind === 'current' ? '' : view.id); setNaming(false); setName('')
    }
  }
  return <div className="space-y-3 text-sm">
    <p className="text-xs leading-5 text-gray-500">布局按账号和项目保存，包含筛选、显示列、列宽、排序、折叠状态和时间轴位置。下次打开此项目会自动恢复。</p>
    <button type="button" disabled={disabled} className="h-9 w-full rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40" onClick={() => void save('current')}>{saving ? '保存中…' : '保存当前布局'}</button>
    {loading && <p role="status" className="text-xs text-gray-500">正在加载布局…</p>}
    {readOnly && <p className="text-xs text-gray-500">分享访客请使用账号登录后保存布局。</p>}
    {layouts.notice && <p role="status" className="text-xs text-green-700">{layouts.notice}</p>}
    {(error || layouts.error) && <div role="alert" className="space-y-2 text-xs text-red-600"><p>{error || layouts.error}</p>
      {layouts.error && <button type="button" disabled={loading || saving} className="text-blue-600" onClick={layouts.reload}>重新加载布局</button>}
    </div>}
    {views.length > 0 ? <>
    <label className="block text-xs font-medium text-gray-600" htmlFor={`saved-layout-${projectId}`}>选择已保存的布局</label>
    <select id={`saved-layout-${projectId}`} aria-label="已保存布局" disabled={loading || saving} className="h-9 w-full rounded border border-gray-300 bg-white px-2" value={selected} onChange={e => {
      setSelected(e.target.value)
      const view = views.find(v => v.id === e.target.value)
      if (view) apply(view)
    }}><option value="">选择布局…</option>{views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
    {selected && <div className="flex items-center gap-4 text-xs">
      <button type="button" className="text-blue-600" onClick={() => { const v = views.find(x => x.id === selected); if (v) apply(v) }}>应用布局</button>
      <button type="button" disabled={disabled} className="text-blue-600 disabled:opacity-40" onClick={() => void save('update')}>更新此布局</button>
      <button type="button" disabled={disabled} className="text-gray-500 hover:text-red-600 disabled:opacity-40" onClick={async () => {
        if (preferences && await persist({ ...preferences, views: views.filter(v => v.id !== selected) })) setSelected('')
      }}>删除布局</button>
    </div>}
    </> : <p className="rounded-lg bg-gray-50 px-3 py-4 text-center text-gray-400">还没有保存过常用布局</p>}
    {!naming && <button type="button" disabled={disabled} className="h-9 w-full rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-40" onClick={() => setNaming(true)}>另存为常用布局</button>}
    {naming && <form className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3" onSubmit={e => { e.preventDefault(); void save('new') }} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(false) }
    }}>
      <label className="block text-xs text-gray-600" htmlFor={`layout-name-${projectId}`}>布局名称</label>
      <input id={`layout-name-${projectId}`} autoFocus aria-label="布局名称" placeholder="例如：周例会、采购跟踪" maxLength={60} value={name} onChange={e => setName(e.target.value)} className="w-full rounded border border-gray-300 bg-white p-2" />
      <div className="flex justify-end gap-3"><button type="button" onClick={() => setNaming(false)}>取消</button><button type="submit" disabled={disabled || !name.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">保存布局</button></div>
    </form>}
  </div>
}
