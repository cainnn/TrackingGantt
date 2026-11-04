import type { PlanningStatus } from '../types'

// Projects and snapshots created before plan states were introduced are stable.
export function normalizePlanningStatus(value: unknown): PlanningStatus {
  return value === 'draft' ? 'draft' : 'stable'
}

export function isPlanningStatus(value: unknown): value is PlanningStatus {
  return value === 'draft' || value === 'stable'
}

export function planningStatusLabel(value: unknown): string {
  return normalizePlanningStatus(value) === 'draft' ? '草稿态' : '稳定态'
}

export function changeReasonsComplete(
  status: PlanningStatus,
  taskCodes: Iterable<string>,
  dependencyIds: Iterable<string>,
  taskReasons: Record<string, string>,
  dependencyReasons: Record<string, string>,
): boolean {
  if (status === 'draft') return true
  return [...taskCodes].every(code => !!taskReasons[code]?.trim())
    && [...dependencyIds].every(id => !!dependencyReasons[id]?.trim())
}
