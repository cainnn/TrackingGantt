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
export function readSavedViews(raw: string | null): SavedGanttView[] {
  try {
    const values: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(values)) return []
    return values.filter((v): v is SavedGanttView => !!v && typeof v.id === 'string' && typeof v.name === 'string'
      && typeof v.search === 'string' && Array.isArray(v.columns) && v.columns.every((c: unknown) => typeof c === 'string')
      && typeof v.colW === 'number' && Number.isFinite(v.colW) && v.colW > 0
      && v.indicators && typeof v.indicators.deadlineDate === 'boolean' && typeof v.indicators.constraintDate === 'boolean'
      && v.chart && Number.isFinite(v.chart.centerTime) && Number.isFinite(v.chart.scrollTop)
      && Number.isFinite(v.chart.nameWidth) && Number.isFinite(v.chart.panelWidth)
      && v.chart.expanded && Object.values(v.chart.expanded).every(x => typeof x === 'boolean')
      && v.chart.widths && Object.values(v.chart.widths).every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
      && v.chart.filters && Object.values(v.chart.filters).every(x => Array.isArray(x) && x.every(y => typeof y === 'string'))
      && [null, 'asc', 'desc'].includes(v.chart.sortDir)).slice(0, 20)
  } catch { return [] }
}
