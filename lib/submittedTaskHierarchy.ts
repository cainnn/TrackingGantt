export interface HierarchyTask {
  id: string
  parent_id?: string | null
  is_deleted?: boolean
  name?: string
  task_code?: string
}

export interface HierarchyRepair {
  taskId: string
  taskName: string
  requestedParent: string | null
  parentId: string | null
  message: string
}

/** Resolve the complete submitted graph, before applying any individual row.
 * Only same-project records are supplied as existing. An invalid edge must not
 * discard all the user's other edits or copy data from another project. */
export function planSubmittedHierarchy(existing: HierarchyTask[], submitted: HierarchyTask[]) {
  const old = new Map(existing.map(t => [t.id, t]))
  const nodes = new Map(existing.map(t => [t.id, { ...t }]))
  const explicitParents = new Set(submitted.filter(t => Object.hasOwn(t, 'parent_id')).map(t => t.id))
  for (const task of submitted) nodes.set(task.id, { ...old.get(task.id), ...task, is_deleted: false })
  for (const node of nodes.values()) {
    node.parent_id = typeof node.parent_id === 'string' ? node.parent_id.trim() || null
      : node.parent_id == null ? null : String(node.parent_id)
  }
  const repairs: HierarchyRepair[] = []
  const touched = new Set(submitted.map(t => t.id))

  const repair = (id: string, reason: string, forbidden = new Set<string>()) => {
    const node = nodes.get(id)!
    const requestedParent = node.parent_id ?? null
    const previous = old.get(id)?.parent_id ?? null
    // Retain a known valid previous parent when possible, otherwise keep the
    // task as a root. Never invent a replacement task or lose its other fields.
    let fallback = previous && previous !== id && !forbidden.has(previous) && nodes.has(previous) ? previous : null
    const seen = new Set([id])
    let cursor = fallback
    while (cursor) {
      if (seen.has(cursor)) { fallback = null; break }
      seen.add(cursor)
      cursor = nodes.get(cursor)?.parent_id ?? null
    }
    node.parent_id = fallback
    touched.add(id)
    repairs.push({ taskId: id, taskName: node.name || node.task_code || id,
      requestedParent, parentId: fallback,
      message: `${reason}，${fallback ? '保留原有效父任务' : '改为顶级任务'}；任务内容已保留`,
    })
  }

  // Follow only submitted tasks and their ancestors; unrelated historical
  // records, including deleted siblings, stay unchanged.
  for (const task of submitted) {
    const path: string[] = []
    let cursor: string | null = task.id
    while (cursor) {
      const node: HierarchyTask = nodes.get(cursor)!
      const cycleAt = path.indexOf(cursor)
      if (cycleAt >= 0) {
        const cycle = path.slice(cycleAt)
        const edge: string = cycle.find(id => explicitParents.has(id)) ?? cursor
        repair(edge, '父子关系形成循环', new Set(cycle))
        path.length = 0
        cursor = edge
        continue
      }
      path.push(cursor)
      touched.add(cursor)
      if (node.parent_id && (node.parent_id === cursor || !nodes.has(node.parent_id))) {
        repair(cursor, node.parent_id === cursor ? '任务不能作为自身父任务' : '父任务不存在于当前项目')
      }
      cursor = node.parent_id ?? null
    }
  }
  return {
    parents: [...touched].map(id => ({ id, parent_id: nodes.get(id)!.parent_id ?? null })),
    restoreIds: [...touched].filter(id => old.get(id)?.is_deleted),
    repairs,
  }
}

/** Old open tabs already send complete task rows as arrays. Recognize that
 * contract so they can retry without refreshing and losing their draft. */
export function isSubmittedTaskBatch(body: unknown): boolean {
  return Array.isArray(body) && body.length > 0 && body.every(task => task && typeof task === 'object'
    && ['id', 'name', 'parent_id', 'start_date', 'end_date', 'duration', 'order_index'].every(key => Object.hasOwn(task, key)))
}
