import test from 'node:test'
import assert from 'node:assert/strict'
import { dependencyRoute, downstreamLookup, rangeIndices, routeIntersects, viewportRange } from '../lib/ganttViewport'
import type { Dependency } from '../types'

test('virtual rows retain global indices, overscan and clamp after filtering', () => {
  assert.deepEqual(viewportRange(10000, 40, 200000, 800, 6), { start: 4994, end: 5026 })
  assert.deepEqual(viewportRange(3, 40, 200000, 800, 6), { start: 0, end: 3 })
  assert.deepEqual(viewportRange(0, 40, 0, 800), { start: 0, end: 0 })
  const indices = rangeIndices({ start: 100, end: 103 }, [4, 101, 200, -1, NaN])
  assert.deepEqual(indices, [4, 100, 101, 102, 200])
})
test('minute tick count is bounded by viewport width even on a multi-year plan', () => {
  const range = viewportRange(3650 * 96, 15, 2000000, 1200, 2)
  assert.ok(range.end - range.start <= 85)
  assert.ok(range.start * 15 <= 2000000 && range.end * 15 >= 2001200)
})
test('dependency culling keeps crossing routes with both tasks off screen', () => {
  const bounds = { left: 90, right: 130, top: 400, bottom: 800 }
  assert.equal(routeIntersects(dependencyRoute(100, 20, 200, 2000, 2).points, bounds), true)
  assert.equal(routeIntersects(dependencyRoute(400, 20, 500, 2000, 2).points, bounds), false)
  // A bounding rectangle alone would falsely intersect this viewport.
  assert.equal(routeIntersects(dependencyRoute(0, 20, 200, 2000, 2).points, bounds), false)
  for (const type of [0, 1, 2, 3]) {
    const { points } = dependencyRoute(200, 100, 80, 300, type)
    assert.deepEqual(points.at(-1), { x: 80, y: 300 })
    assert.equal(routeIntersects(points, { left: 65, right: 95, top: 290, bottom: 310 }), true)
  }
})
test('lazy downstream traversal handles long chains, branching, inactive links and cycles', () => {
  const deps = Array.from({ length: 9999 }, (_, i) => ({ from_task_id: String(i), to_task_id: String(i + 1) } as Dependency))
  deps.push({ from_task_id: '9999', to_task_id: '0' } as Dependency)
  deps.push({ from_task_id: '0', to_task_id: 'inactive', active: false } as Dependency)
  deps.push({ from_task_id: '0', to_task_id: '2' } as Dependency)
  const lookup = downstreamLookup(deps)
  assert.equal(lookup('0').length, 9999)
  assert.deepEqual(lookup('missing'), [])
  assert.equal(lookup('9999').includes('9999'), false)
})
