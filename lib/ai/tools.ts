import type { Task, Dependency } from '@/types'
import { computeTimeBasedPercent } from '@/lib/projectProgress'

// ── OpenAI tool definitions ────────────────────────────────────────────────
export const AI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Create a new task in the project',
      parameters: {
        type: 'object',
        properties: {
          name:             { type: 'string', description: 'Task name' },
          start_date:       { type: 'string', description: 'Start date YYYY-MM-DD' },
          end_date:         { type: 'string', description: 'End date YYYY-MM-DD' },
          duration:         { type: 'number', description: 'Duration in days' },
          assignee:         { type: 'string', description: 'Person responsible' },
          parent_task_code: { type: 'string', description: 'Parent task code to nest under' },
          is_milestone:     { type: 'boolean', description: 'Whether this is a milestone (duration=0)' },
          note:             { type: 'string', description: 'Task notes' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update one or more fields of an existing task',
      parameters: {
        type: 'object',
        properties: {
          task_code:    { type: 'string', description: 'The task code to update' },
          name:         { type: 'string' },
          start_date:   { type: 'string', description: 'YYYY-MM-DD' },
          end_date:     { type: 'string', description: 'YYYY-MM-DD' },
          duration:     { type: 'number' },
          assignee:     { type: 'string' },
          percent_done: { type: 'number', description: '0-100' },
          is_milestone: { type: 'boolean' },
          note:         { type: 'string' },
        },
        required: ['task_code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_tasks',
      description: 'Delete one or more tasks by their task codes',
      parameters: {
        type: 'object',
        properties: {
          task_codes: { type: 'array', items: { type: 'string' }, description: 'Task codes to delete' },
        },
        required: ['task_codes'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_dependency',
      description: 'Create a dependency between two tasks',
      parameters: {
        type: 'object',
        properties: {
          from_task_code: { type: 'string', description: 'Predecessor task code' },
          to_task_code:   { type: 'string', description: 'Successor task code' },
          type:           { type: 'number', enum: [0, 1, 2, 3], description: '0=SS, 1=SF, 2=FS(default), 3=FF' },
          lag:            { type: 'number', description: 'Lag in days (default 0)' },
        },
        required: ['from_task_code', 'to_task_code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remove_dependency',
      description: 'Remove a dependency between two tasks',
      parameters: {
        type: 'object',
        properties: {
          from_task_code: { type: 'string' },
          to_task_code:   { type: 'string' },
        },
        required: ['from_task_code', 'to_task_code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bulk_update_tasks',
      description: 'Update the same field(s) across multiple tasks at once',
      parameters: {
        type: 'object',
        properties: {
          task_codes: { type: 'array', items: { type: 'string' } },
          updates: {
            type: 'object',
            properties: {
              assignee:     { type: 'string' },
              percent_done: { type: 'number' },
              start_date:   { type: 'string' },
              end_date:     { type: 'string' },
              duration:     { type: 'number' },
            },
          },
        },
        required: ['task_codes', 'updates'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_task_changes',
      description: 'Query task change history for a date range. Returns all field-level changes (created, updated, deleted, moved) within the period. Use this when user asks about weekly/daily summary, what changed, task history, or version tracking.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
          to_date:   { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        },
        required: ['from_date', 'to_date'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_version_diffs',
      description: 'Get task diffs stored with version snapshots. Each version records what changed compared to the previous version (added/removed/changed tasks with field-level details). Use this when user asks about version comparison, what changed between status dates, or version history analysis. Can query a specific version or list recent versions with their diffs.',
      parameters: {
        type: 'object',
        properties: {
          version_id: { type: 'string', description: 'Specific version ID to get diffs for. If omitted, returns recent versions with diffs.' },
          limit:      { type: 'number', description: 'Number of recent versions to return (default 5, max 20). Ignored if version_id is provided.' },
        },
      },
    },
  },
]

// ── Version changes summary type ──────────────────────────────────────────
export interface VersionChangesSummary {
  name: string
  status_date: string | null
  stats: { added: number; removed: number; changed: number }
  diffs: { task_code: string; task_name: string; type: string; changes?: { field: string; old: string; new: string }[] }[]
}

// ── System prompt builder ──────────────────────────────────────────────────
export function buildSystemPrompt(
  projectName: string,
  tasks: Task[],
  dependencies: Dependency[],
  versionChanges?: VersionChangesSummary[],
  statusDate?: string | null,
  progress?: number | null,
): string {
  const codeById = new Map(tasks.map(t => [t.id, t.task_code]))

  const taskRows = tasks.slice(0, 200).map(t => {
    const parentCode = t.parent_id ? (codeById.get(t.parent_id) ?? '') : ''
    const pct = computeTimeBasedPercent(t, statusDate)
    return [
      t.task_code, t.name,
      t.start_date?.split('T')[0] ?? '', t.end_date?.split('T')[0] ?? '',
      t.duration ?? '', t.assignee ?? '', pct,
      parentCode, t.is_milestone ? 'Y' : '',
    ].join(' | ')
  })

  const depTypeNames = ['SS', 'SF', 'FS', 'FF']
  const depRows = dependencies.map(d => {
    const from = codeById.get(d.from_task_id) ?? '?'
    const to   = codeById.get(d.to_task_id) ?? '?'
    return `${from} -> ${to} (${depTypeNames[d.type] ?? 'FS'}, lag=${d.lag})`
  })

  // 构建版本变更文本
  let versionChangesText = '(无版本变更记录)'
  if (versionChanges && versionChanges.length > 0) {
    const lines: string[] = []
    for (const vc of versionChanges) {
      lines.push(`版本 "${vc.name}" (状态日期: ${vc.status_date ?? '未知'}): 新增${vc.stats.added} 修改${vc.stats.changed} 删除${vc.stats.removed}`)
      for (const d of vc.diffs) {
        if (d.type === 'added') lines.push(`  [新增] ${d.task_code} ${d.task_name}`)
        else if (d.type === 'removed') lines.push(`  [删除] ${d.task_code} ${d.task_name}`)
        else if (d.type === 'changed' && d.changes) {
          for (const c of d.changes) {
            lines.push(`  ${d.task_code} ${d.task_name}: ${c.field} "${c.old}" → "${c.new}"`)
          }
        }
      }
    }
    versionChangesText = lines.join('\n')
  }

  const today = new Date().toISOString().split('T')[0]
  const monday = (() => {
    const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d.toISOString().split('T')[0]
  })()

  return `You are an AI assistant for a Gantt chart project management application.
You help users manage tasks: create, modify, delete, reassign, and answer questions.

Project: "${projectName}"
Today: ${today}
${statusDate ? `Status date: ${typeof statusDate === 'string' && statusDate.includes('T') ? statusDate.split('T')[0] : statusDate}` : 'Status date: not set'}
${progress != null ? `Overall progress: ${progress}%` : ''}

Tasks (code | name | start | end | duration | assignee | %done | parent_code | milestone):
${taskRows.length > 0 ? taskRows.join('\n') : '(empty)'}
${tasks.length > 200 ? `... and ${tasks.length - 200} more tasks` : ''}

Dependencies:
${depRows.length > 0 ? depRows.join('\n') : '(none)'}

Recent version changes (版本变更记录):
${versionChangesText}

Rules:
- When creating tasks, provide name. start_date/end_date/duration are optional but recommended (YYYY-MM-DD).
- When the user refers to a task by name or code, match from the context above.
- For ambiguous references, ask the user to clarify.
- Respond in the same language the user uses.
- For pure questions (e.g. "which tasks are late?"), answer with text — no tool calls needed.
- You may call multiple tools in one response for batch operations.
- Use task_code (not internal id) when referencing tasks.
- **IMPORTANT — Summarizing progress or changes:** When the user asks to "总结进展", "总结本周", "项目进展", "weekly summary", or any variation about project progress / change summary:
  1. Call get_task_changes with from_date="${monday}" and to_date="${today}" to get this week's task-level change log (new tasks, deleted tasks, field modifications).
  2. Also call get_version_diffs to get version snapshot diffs (what changed between status date confirmations).
  3. Combine both results into a structured summary covering:
     - **New tasks** added this period
     - **Deleted tasks** removed this period
     - **Modified tasks** with specific field changes (date shifts, duration changes, reassignments)
     - **Overall status**: current progress percentage, status date, any schedule risks
     - **Potential risks**: tasks that slipped (end date pushed), overdue tasks (end_date < today but %done < 100)
  You MUST call both tools in parallel in one response, then synthesize a comprehensive summary.
- When the user asks about version comparison or what changed between status dates, use get_version_diffs.
- Today is ${today}. This week: ${monday} ~ ${today}.`
}
