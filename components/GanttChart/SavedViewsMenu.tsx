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
  useEffect(() => {
    try { setViews(readSavedViews(localStorage.getItem(key))) } catch { setViews([]) }
    setSelected(''); setNaming(false); setName(''); setError('')
  }, [key])
  const persist = (next: SavedGanttView[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setViews(next); setError(''); return true }
    catch { setError('浏览器无法保存布局，请检查存储权限'); return false }
  }
  const save = () => {
    const value = capture()
    if (!value) { setError('图表尚未准备好，请稍后重试'); return }
    if (!name.trim()) return
    if (views.length >= 20) { setError('最多保存 20 个布局，请先删除不用的布局'); return }
    const view = { ...value, id: uuid(), name: name.trim().slice(0, 60) }
    if (persist([...views, view])) { setSelected(view.id); setNaming(false); setName('') }
  }
  return <div className="space-y-3 text-sm">
    <p className="text-xs leading-5 text-gray-500">记住当前的筛选、显示列、列宽、折叠状态和时间轴位置，方便下次继续查看。布局仅保存在此浏览器。</p>
    {views.length > 0 ? <>
    <label className="block text-xs font-medium text-gray-600" htmlFor={`saved-layout-${projectId}`}>选择已保存的布局</label>
    <select id={`saved-layout-${projectId}`} aria-label="已保存布局" className="h-9 w-full rounded border border-gray-300 bg-white px-2" value={selected} onChange={e => {
      setSelected(e.target.value)
      const view = views.find(v => v.id === e.target.value)
      if (view) apply(view)
    }}><option value="">选择布局…</option>{views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
    {selected && <div className="flex items-center gap-4 text-xs">
      <button type="button" className="text-blue-600" onClick={() => { const v = views.find(x => x.id === selected); if (v) apply(v) }}>应用布局</button>
      <button type="button" className="text-gray-500 hover:text-red-600" onClick={() => { if (persist(views.filter(v => v.id !== selected))) setSelected('') }}>删除布局</button>
    </div>}
    </> : <p className="rounded-lg bg-gray-50 px-3 py-4 text-center text-gray-400">还没有保存过布局</p>}
    {!naming && <button type="button" className="h-9 w-full rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100" onClick={() => setNaming(true)}>保存当前布局</button>}
    {error && <span role="alert" className="text-red-600">{error}</span>}
    {naming && <form className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3" onSubmit={e => { e.preventDefault(); save() }} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(false) }
    }}>
      <label className="block text-xs text-gray-600" htmlFor={`layout-name-${projectId}`}>布局名称</label>
      <input id={`layout-name-${projectId}`} autoFocus aria-label="布局名称" placeholder="例如：周例会、采购跟踪" maxLength={60} value={name} onChange={e => setName(e.target.value)} className="w-full rounded border border-gray-300 bg-white p-2" />
      <div className="flex justify-end gap-3"><button type="button" onClick={() => setNaming(false)}>取消</button><button type="submit" disabled={!name.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">保存布局</button></div>
    </form>}
  </div>
}
