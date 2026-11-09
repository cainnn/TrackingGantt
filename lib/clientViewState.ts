// This schema deliberately contains only presentation preferences, never tasks,
// dependency records, project lines, drafts or undo history.
export interface ChartViewState {
  expanded: Record<string, boolean>
  filters: Record<string, string[]>
  sortCol: string | null
  sortDir: 'asc' | 'desc' | null
  widths: Record<string, number>
  nameWidth: number
  panelWidth: number
  panelCollapsed: boolean
  rightCollapsed: boolean
  centerTime: number
  scrollTop: number
}
export interface SavedGanttView {
  id: string
  name: string
  search: string
  columns: string[]
  indicators: { deadlineDate: boolean; constraintDate: boolean }
  colW: number
  critical: boolean
  chart: ChartViewState
}

export interface ProjectViewPreferences {
  revision: number
  currentView: SavedGanttView | null
  views: SavedGanttView[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown, max = 10000): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && v.length <= 1000)
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

// Return a projection so layout requests can never persist task data or draft history.
export function normalizeSavedView(value: unknown): SavedGanttView | null {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 100
    || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60
    || typeof value.search !== 'string' || value.search.length > 1000 || !strings(value.columns, 100)
    || !finite(value.colW, 0.1, 2880) || typeof value.critical !== 'boolean'
    || !record(value.indicators) || typeof value.indicators.deadlineDate !== 'boolean' || typeof value.indicators.constraintDate !== 'boolean'
    || !record(value.chart)) return null
  const chart = value.chart
  if (!finite(chart.centerTime, -8640000000000000, 8640000000000000) || !finite(chart.scrollTop, 0, 100000000)
    || !finite(chart.nameWidth, 1, 20000) || !finite(chart.panelWidth, 1, 20000)
    || typeof chart.panelCollapsed !== 'boolean' || typeof chart.rightCollapsed !== 'boolean'
    || !(chart.sortCol === null || (typeof chart.sortCol === 'string' && chart.sortCol.length <= 100))
    || ![null, 'asc', 'desc'].includes(chart.sortDir as null | string)
    || !record(chart.expanded) || Object.keys(chart.expanded).length > 100000 || !Object.values(chart.expanded).every(v => typeof v === 'boolean')
    || !record(chart.widths) || Object.keys(chart.widths).length > 100 || !Object.values(chart.widths).every(v => finite(v, 1, 20000))
    || !record(chart.filters) || Object.keys(chart.filters).length > 100 || !Object.values(chart.filters).every(v => strings(v))) return null
  return {
    id: value.id, name: value.name.trim(), search: value.search, columns: [...new Set(value.columns)],
    indicators: { deadlineDate: value.indicators.deadlineDate, constraintDate: value.indicators.constraintDate },
    colW: value.colW, critical: value.critical,
    chart: {
      expanded: { ...chart.expanded } as Record<string, boolean>, filters: Object.fromEntries(Object.entries(chart.filters).map(([k, v]) => [k, [...v as string[]]])),
      sortCol: chart.sortCol, sortDir: chart.sortDir as ChartViewState['sortDir'], widths: { ...chart.widths } as Record<string, number>,
      nameWidth: chart.nameWidth, panelWidth: chart.panelWidth, panelCollapsed: chart.panelCollapsed, rightCollapsed: chart.rightCollapsed,
      centerTime: chart.centerTime, scrollTop: chart.scrollTop,
    },
  }
}

export function normalizeProjectViewPreferences(value: unknown): ProjectViewPreferences | null {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !finite(value.revision, 0, 2147483646)
    || !Array.isArray(value.views) || value.views.length > 20) return null
  const views = value.views.map(normalizeSavedView)
  const currentView = value.currentView === null ? null : normalizeSavedView(value.currentView)
  if (views.some(v => v === null) || (value.currentView !== null && !currentView)
    || new Set(views.map(v => v!.id)).size !== views.length) return null
  return { revision: value.revision as number, currentView, views: views as SavedGanttView[] }
}

export function readSavedViews(raw: string | null): SavedGanttView[] {
  try {
    const values: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    return values.map(normalizeSavedView).filter((v): v is SavedGanttView => {
      if (!v || seen.has(v.id)) return false
      seen.add(v.id)
      return true
    }).slice(0, 20)
  } catch { return [] }
}
