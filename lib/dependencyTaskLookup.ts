import type { Task } from '../types'

export interface DependencyTaskOption { id: string; number: number; name: string; searchName: string }
export function buildDependencyTaskLookup(tasks: Task[], numbers: Map<string, number>) {
  const summaries = new Set(tasks.filter(t => !t.is_deleted).map(t => t.parent_id).filter(Boolean))
  const entries: DependencyTaskOption[] = []
  for (const task of tasks) {
    const number = numbers.get(task.id)
    if (number == null || task.is_deleted || summaries.has(task.id)) continue
    entries.push({ id: task.id, number, name: task.name, searchName: task.name.toLocaleLowerCase() })
  }
  entries.sort((a, b) => a.number - b.number)
  return { entries, byNumber: new Map(entries.map(entry => [entry.number, entry])) }
}

/** Numbers refer to the visible 编号 column, never persistent task_code values. */
export function findDependencyTasks(index: ReturnType<typeof buildDependencyTaskLookup>, query: string, excludedId: string, selectedIds: Set<string>, limit = 30) {
  const q = query.trim().toLocaleLowerCase()
  if (/^#?\d+$/.test(q)) {
    const exact = index.byNumber.get(Number(q.replace(/^#/, '')))
    return { options: exact && exact.id !== excludedId ? [exact] : [], more: false }
  }
  const options: DependencyTaskOption[] = []
  const seen = new Set<string>()
  const add = (entry: DependencyTaskOption) => {
    if (entry.id === excludedId || seen.has(entry.id) || (q && !entry.searchName.includes(q))) return
    seen.add(entry.id); options.push(entry)
  }
  // Existing relations stay easy to remove even when their numbers are large.
  if (!q && selectedIds.size) for (const entry of index.entries) {
    if (selectedIds.has(entry.id)) add(entry)
    if (options.length > limit) break
  }
  if (options.length <= limit) for (const entry of index.entries) {
    add(entry)
    if (options.length > limit) break
  }
  return { options: options.slice(0, limit), more: options.length > limit }
}
