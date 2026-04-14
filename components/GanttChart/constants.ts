export const CONSTRAINT_TYPES: { value: string; label: string; needsDate?: boolean }[] = [
  { value: 'none',                   label: '无' },
  { value: 'asap',                   label: '尽早' },
  { value: 'alap',                   label: '尽晚' },
  { value: 'muststarton',            label: '必须于…开始',     needsDate: true },
  { value: 'mustfinishon',           label: '必须于…结束',     needsDate: true },
  { value: 'startnoearlierthan',     label: '不早于…开始',     needsDate: true },
  { value: 'finishnoearlierthan',    label: '不早于…结束',     needsDate: true },
  { value: 'startnolaterthan',       label: '不迟于…开始',     needsDate: true },
  { value: 'finishnolaterthan',      label: '不迟于…结束',     needsDate: true },
]
export const DEFAULT_CONSTRAINT_TYPE = 'asap'
export const CONSTRAINT_NEEDS_DATE = new Set(
  CONSTRAINT_TYPES.filter(c => c.needsDate).map(c => c.value),
)
