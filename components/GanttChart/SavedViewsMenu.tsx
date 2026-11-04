'use client'
import { useEffect, useState } from 'react'
import { readSavedViews, type SavedGanttView } from '@/lib/clientViewState'
import { uuid } from '@/lib/uuid'

export default function SavedViewsMenu({ projectId, capture, apply }: {
  projectId: string
  capture: () => Omit<SavedGanttView, 'id' | 'name'> | null
  apply: (view: SavedGanttView) => void
}) {
  const key = `gantt-saved-views-v1-${projectId}`
  const [views, setViews] = useState<SavedGanttView[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => { try { setViews(readSavedViews(localStorage.getItem(key))) } catch { setViews([]) } }, [key])
  const persist = (next: SavedGanttView[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setViews(next); setError(''); return true }
    catch { setError('浏览器无法保存视图，请检查存储权限'); return false }
  }
  const save = () => {
    const value = capture()
    if (!value) return
    if (!name.trim()) return
    if (views.length >= 20) { setError('最多保存 20 个视图，请先删除不用的视图'); return }
    const view = { ...value, id: uuid(), name: name.trim().slice(0, 60) }
    if (persist([...views, view])) { setSelected(view.id); setNaming(false); setName('') }
  }
  return <div className="flex items-center gap-1 text-xs">
    <select aria-label="已保存视图" className="border border-gray-300 rounded h-8 max-w-32" value={selected} onChange={e => {
      setSelected(e.target.value)
      const view = views.find(v => v.id === e.target.value)
      if (view) apply(view)
    }}><option value="">已保存视图</option>{views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
    <button className="border border-gray-300 rounded px-2 h-8" onClick={() => setNaming(true)}>保存视图</button>
    {selected && <><button title="重新应用所选视图" onClick={() => { const v = views.find(x => x.id === selected); if (v) apply(v) }}>应用</button><button title="删除所选视图" onClick={() => { persist(views.filter(v => v.id !== selected)); setSelected('') }}>删除视图</button></>}
    {error && <span role="alert" className="text-red-600">{error}</span>}
    {naming && <div role="dialog" aria-modal="true" aria-label="保存视图" className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); setNaming(false) }
    }}>
      <form className="w-80 space-y-3 rounded-lg bg-white p-5 shadow-xl" onSubmit={e => { e.preventDefault(); save() }}>
        <h3 className="text-sm font-semibold">保存视图</h3>
        <p className="text-gray-500">保存当前筛选、列、展开状态、缩放和位置。</p>
        <input autoFocus aria-label="视图名称" maxLength={60} value={name} onChange={e => setName(e.target.value)} className="w-full rounded border border-gray-300 p-2" />
        <div className="flex justify-end gap-3"><button type="button" onClick={() => setNaming(false)}>取消</button><button type="submit" disabled={!name.trim()} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-40">保存当前视图</button></div>
      </form>
    </div>}
  </div>
}
