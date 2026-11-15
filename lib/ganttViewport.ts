import type { Dependency } from '../types'

/** Half-open indices into the complete row/tick list. Coordinates stay global. */
export function viewportRange(count: number, size: number, offset: number, extent: number, overscan = 4) {
  if (count <= 0 || size <= 0) return { start: 0, end: 0 }
  const position = Math.max(0, Math.min(offset, Math.max(0, count * size - extent)))
  return {
    start: Math.max(0, Math.floor(position / size) - overscan),
    end: Math.min(count, Math.ceil((position + Math.max(0, extent)) / size) + overscan),
  }
}

export function rangeIndices(range: { start: number; end: number }, pinned: number[] = []) {
  const indices = new Set(Array.from({ length: range.end - range.start }, (_, i) => range.start + i))
  pinned.forEach(i => { if (Number.isInteger(i) && i >= 0) indices.add(i) })
  return [...indices].sort((a, b) => a - b)
}

export interface ChartPoint { x: number; y: number }
export interface ChartBounds { left: number; top: number; right: number; bottom: number }

/** Preserve the existing orthogonal routing for SS/SF/FS/FF. */
export function dependencyRoute(x1: number, y1: number, x2: number, y2: number, type: number) {
  const exitRight = type === 2 || type === 3
  const enterLeft = type === 0 || type === 2
  const dx1 = exitRight ? 10 : -10, dx2 = enterLeft ? -10 : 10
  const points: ChartPoint[] = [{ x: x1, y: y1 }, { x: x1 + dx1, y: y1 }]
  if ((exitRight && x2 > x1 + 20) || (!exitRight && x2 > x1)) {
    points.push({ x: x1 + dx1, y: y2 })
  } else {
    const midY = Math.min(y1, y2) - 8
    points.push({ x: x1 + dx1, y: midY }, { x: x2 + dx2, y: midY }, { x: x2 + dx2, y: y2 })
  }
  points.push({ x: x2, y: y2 })
  return { points, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') }
}

/** Keep crossing lines even when both endpoint tasks are outside the viewport. */
export function routeIntersects(points: ChartPoint[], bounds: ChartBounds) {
  return points.some((p, i) => {
    if (!i) return false
    const previous = points[i - 1]
    return Math.max(p.x, previous.x) >= bounds.left && Math.min(p.x, previous.x) <= bounds.right
      && Math.max(p.y, previous.y) >= bounds.top && Math.min(p.y, previous.y) <= bounds.bottom
  })
}

/** Index once, traverse only the task being dragged; no all-pairs transitive cache. */
export function downstreamLookup(dependencies: Dependency[]) {
  const outgoing = new Map<string, string[]>()
  for (const dep of dependencies) {
    if (dep.active === false) continue
    const children = outgoing.get(dep.from_task_id) ?? []
    children.push(dep.to_task_id); outgoing.set(dep.from_task_id, children)
  }
  return (id: string) => {
    const seen = new Set([id]), result: string[] = [], pending = [...(outgoing.get(id) ?? [])].reverse()
    while (pending.length) {
      const next = pending.pop()!
      if (seen.has(next)) continue
      seen.add(next); result.push(next)
      const children = outgoing.get(next) ?? []
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
    }
    return result
  }
}
