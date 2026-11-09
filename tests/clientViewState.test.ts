import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProjectViewPreferences, normalizeSavedView, readSavedViews, type SavedGanttView } from '../lib/clientViewState'

function view(): SavedGanttView {
  return {
    id: 'weekly', name: '周例会', search: '采购', columns: [], colW: 0.1, critical: true,
    indicators: { deadlineDate: false, constraintDate: true },
    chart: {
      expanded: { parent: false }, filters: { assignee: ['张三', ''] }, sortCol: 'start', sortDir: 'desc',
      widths: { start: 172 }, nameWidth: 356, panelWidth: 1380, panelCollapsed: false, rightCollapsed: true,
      centerTime: new Date('2026-11-08T09:35:00').getTime(), scrollTop: 224,
    },
  }
}

test('layout roundtrip retains hidden columns, order, filters, dimensions, collapse state and minute viewport', () => {
  for (const columns of [[], ['end', 'assignee', 'start']]) {
    const current = { ...view(), columns }
    const value = { revision: 3, currentView: current, views: [current] }
    assert.deepEqual(normalizeProjectViewPreferences(JSON.parse(JSON.stringify(value))), value)
  }
})

test('layout validation projects out tasks, draft history and unrelated nested data', () => {
  const original = view()
  const normalized = normalizeSavedView({ ...original, tasks: [{ name: 'do not save' }], draft: { steps: [1] },
    indicators: { ...original.indicators, statusDate: '2020-01-01' }, chart: { ...original.chart, dependencies: [1] } })
  assert.deepEqual(normalized, original)
  normalized!.chart.filters.assignee.push('李四')
  assert.deepEqual(original.chart.filters.assignee, ['张三', ''])
})

test('invalid layouts are rejected instead of partially overwriting saved preferences', () => {
  const original = view()
  for (const patch of [
    { critical: undefined }, { indicators: { deadlineDate: true } }, { id: '' }, { name: ' ' }, { name: 'x'.repeat(61) },
    { columns: [1] }, { colW: 0 }, { colW: Infinity }, { colW: 2881 },
    ...[{ expanded: [] }, { widths: { start: -1 } }, { filters: { start: [false] } }, { scrollTop: -1 },
      { centerTime: NaN }, { panelCollapsed: undefined }, { rightCollapsed: 'false' }, { sortDir: 'sideways' }, { sortCol: {} }]
      .map(chart => ({ chart: { ...original.chart, ...chart } })),
  ]) assert.equal(normalizeSavedView({ ...original, ...patch }), null, JSON.stringify(patch))
})

test('preference revisions, limits and duplicate IDs are checked while empty projects are valid', () => {
  assert.deepEqual(normalizeProjectViewPreferences({ revision: 0, currentView: null, views: [] }), { revision: 0, currentView: null, views: [] })
  for (const revision of [-1, 1.5, NaN, '1', undefined, Number.MAX_SAFE_INTEGER]) assert.equal(normalizeProjectViewPreferences({ revision, currentView: null, views: [] }), null)
  assert.equal(normalizeProjectViewPreferences({ revision: 1, currentView: {}, views: [] }), null)
  assert.equal(normalizeProjectViewPreferences({ revision: 1, currentView: null, views: [view(), view()] }), null)
  assert.equal(normalizeProjectViewPreferences({ revision: 1, currentView: null, views: Array.from({ length: 21 }, (_, i) => ({ ...view(), id: String(i) })) }), null)
})

test('browser layout migration retains valid entries when malformed or duplicate entries coexist', () => {
  const original = view()
  assert.deepEqual(readSavedViews(JSON.stringify([null, {}, original, original, { ...original, id: 'second' }])), [original, { ...original, id: 'second' }])
  for (const raw of [null, 'broken', '{}', 'null']) assert.deepEqual(readSavedViews(raw), [])
})
