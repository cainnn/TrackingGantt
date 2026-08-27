import type { Task, Dependency } from '@/types'
import { computeTimeBasedPercent } from '@/lib/projectProgress'
import { formatMinDuration } from '@/lib/clientTime'
import { WEEKLY_SUMMARY_OUTPUT_REQUIREMENT } from '@/lib/ai/summaryPolicy'

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
          start_date:       { type: 'string', description: 'Start datetime: YYYY-MM-DDTHH:mm or YYYY-MM-DD (defaults 00:00)' },
          end_date:         { type: 'string', description: 'End datetime: YYYY-MM-DDTHH:mm or YYYY-MM-DD' },
          duration:         { type: 'number', description: 'Duration in minutes (1 hour=60, 1 day=1440)' },
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
          start_date:   { type: 'string', description: 'YYYY-MM-DDTHH:mm or YYYY-MM-DD' },
          end_date:     { type: 'string', description: 'YYYY-MM-DDTHH:mm or YYYY-MM-DD' },
          duration:     { type: 'number' },
          assignee:     { type: 'string' },
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
          lag:            { type: 'number', description: 'Lag in the current project unit: minutes for minute-level projects, days for day-level projects (default 0)' },
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

function fmtStatusDateForPrompt(statusDate?: string | null): string {
  if (!statusDate) return 'not set'
  const s = String(statusDate)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/)
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : s
}

// ── System prompt builder ──────────────────────────────────────────────────
export function buildSystemPrompt(
  projectName: string,
  tasks: Task[],
  dependencies: Dependency[],
  versionChanges?: VersionChangesSummary[],
  statusDate?: string | null,
  progress?: number | null,
  prevTaskIds?: string[],  // 上期快照存在的任务 ID，缺失则视为本期新增
  isMinute: boolean = true,  // 项目粒度：true=分钟级（默认），false=天级 → 时长摘要按整天输出
): string {
  const prevIdSet = prevTaskIds ? new Set(prevTaskIds) : null
  const dayOnly = !isMinute
  const fmtDur = (mins: number, signed = false) =>
    formatMinDuration(mins, { signed, dayOnly })
  const codeById = new Map(tasks.map(t => [t.id, t.task_code]))
  const taskById = new Map(tasks.map(t => [t.id, t] as const))

  // 辅助：判断任务 end_date 是否相对 baseline 延长（分钟级）
  const isExtended = (tk: Task) => {
    const b = tk.baseline_end_date ? String(tk.baseline_end_date) : null
    const e = tk.end_date ? String(tk.end_date) : null
    return !!(b && e && e > b)
  }

  const taskRows = tasks.slice(0, 200).map(t => {
    const parentCode = t.parent_id ? (codeById.get(t.parent_id) ?? '') : ''
    const pct = computeTimeBasedPercent(t, statusDate)
    const baseline = t.baseline_end_date ? String(t.baseline_end_date) : ''
    const curEnd   = t.end_date ? String(t.end_date) : ''
    let delayFlag = ''
    if (baseline && curEnd && baseline !== curEnd) {
      const mins = Math.round((new Date(curEnd).getTime() - new Date(baseline).getTime()) / 60_000)
      if (mins > 0) delayFlag = `延期${fmtDur(mins, true)}`
      else if (mins < 0) delayFlag = `提前${fmtDur(mins, true)}`
    }
    // 计算延期原因
    let delayReason = ''
    if (delayFlag && delayFlag.startsWith('延期')) {
      const inDeps = dependencies.filter(d => d.to_task_id === t.id && d.active !== false)
      const delayedPreds = inDeps.filter(d => { const p = taskById.get(d.from_task_id); return p ? isExtended(p) : false })
      const newPreds = prevIdSet
        ? inDeps.filter(d => !prevIdSet.has(d.from_task_id))
        : []
      const lagPreds = inDeps.filter(d => (d.lag ?? 0) > 0)
      const reasons: string[] = []
      if (delayedPreds.length > 0) {
        const names = delayedPreds.map(d => {
          const p = taskById.get(d.from_task_id)
          return `${p?.task_code ?? '?'} ${p?.name ?? '?'}`
        }).slice(0, 3)
        reasons.push(`前置任务延期(${names.join(',')})`)
      }
      if (newPreds.length > 0) {
        const names = newPreds.map(d => {
          const p = taskById.get(d.from_task_id)
          return `${p?.task_code ?? '?'} ${p?.name ?? '?'}`
        }).slice(0, 3)
        reasons.push(`新增前置任务(${names.join(',')})`)
      }
      if (lagPreds.length > 0) {
        const descs = lagPreds.map(d => {
          const p = taskById.get(d.from_task_id)
          return `${p?.task_code ?? '?'} ${p?.name ?? '?'}(lag=${fmtDur(d.lag ?? 0)})`
        }).slice(0, 3)
        reasons.push(`依赖延迟(${descs.join(',')})`)
      }
      delayReason = reasons.length > 0 ? reasons.join('; ') : '自身工期延长'
    }
    const durDisplay = t.duration == null
      ? ''
      : (dayOnly ? `${Math.round(t.duration / 1440)}天` : `${t.duration}分钟`)
    return [
      t.task_code, t.name,
      t.created_at?.split('T')[0] ?? '',
      t.start_date?.split('T')[0] ?? '', curEnd,
      durDisplay, t.assignee ?? '', pct,
      parentCode, t.is_milestone ? 'Y' : '',
      baseline, delayFlag, delayReason,
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
  const addMonthsClamped = (date: Date, deltaMonths: number) => {
    const result = new Date(date)
    const day = result.getDate()
    result.setDate(1)
    result.setMonth(result.getMonth() + deltaMonths)
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
    result.setDate(Math.min(day, lastDay))
    return result
  }
  const previousWeek = (() => {
    const d = new Date(); d.setDate(d.getDate() - 7)
    return d.toISOString().split('T')[0]
  })()
  const previousMonth = addMonthsClamped(new Date(), -1).toISOString().split('T')[0]

  return `You are an AI assistant for a Gantt chart project management application.
You help users manage tasks: create, modify, delete, reassign, and answer questions.

Project: "${projectName}"
Today: ${today}
Status date: ${fmtStatusDateForPrompt(statusDate)}
${progress != null ? `Overall progress: ${progress}%` : ''}

Project granularity: ${isMinute ? '分钟级（minute）—— 时长用分钟/小时/天混合输出' : '天级（day）—— 所有时长统一按整天输出，不要出现分钟、小时'}
Tasks (code | name | created | start | end | duration | assignee | %done_ref | parent_code | milestone | baseline_end | delay_flag | delay_reason):
- **created** 是任务创建时间，用于判断本期新增任务及审计上下文。
- **baseline_end** 是上一期版本快照中的计划结束日期。
- **%done_ref** 是按状态日期自动计算出来的参考进度，只能作为背景信息；不要把它作为周报/计划变更分析的主要依据。
- **delay_flag** 格式：${dayOnly
  ? '"延期+N天" / "提前-N天"；这是判定延期/提前的权威依据，总结时必须列出天数。本项目是天级项目，禁止使用分钟、小时单位。'
  : '"延期+N天" / "提前-N天" / "延期+N小时" / "延期+N分钟"，根据实际时长精度输出；为空表示无变化。这是判定延期/提前的权威依据，总结时必须列出。'}
- **delay_reason** 延期原因说明："自身工期延长"表示任务本身被拉长；"前置任务延期(任务名)"表示因上游任务延期被拖累；"依赖延迟(任务名lag=...)"表示因依赖关系的lag设置导致延期。${dayOnly
  ? '总结时所有时长用整天（X 天）描述，禁止出现分钟、小时。'
  : '总结时按实际时长精度描述。所有时长内部以分钟存储；输出时按需换算为分钟/小时/天。'}
${taskRows.length > 0 ? taskRows.join('\n') : '(empty)'}
${tasks.length > 200 ? `... and ${tasks.length - 200} more tasks` : ''}

Dependencies:
${depRows.length > 0 ? depRows.join('\n') : '(none)'}

Recent version changes (版本变更记录):
${versionChangesText}

## Core Tracking Logic — Time-Based Progress

This system uses **time-based progress tracking**, NOT manual percent-done entry. Key concepts:

1. **Status date** is the "as-of" cut line. Everything to the left of the status date on the Gantt chart represents the completed portion.
2. **%done is auto-calculated**: For each task, %done = (status_date − start_date) / (end_date − start_date) × 100, capped at 0–100. Users do NOT manually set percent_done. The %done column shown above is this calculated value.
3. **How progress is tracked at a status date check**:
   - If a task's end_date ≤ status_date → the task is 100% complete.
   - If a task should be complete but is NOT finished in reality, the project manager extends its end_date (and duration) to reflect the remaining work. For example: a task was supposed to end on 03-15, but at status date 03-15 it's found to still need 3 more days → end_date is pushed to 03-18, duration increases by 3. This is recorded in the current version snapshot.
   - This end_date extension is the primary way delays are captured — NOT by setting a partial percent_done.
4. **Risk detection**: A task is at risk if its end_date was pushed compared to the previous version snapshot (version diff shows end_date changed). Compare current task end_dates against the previous version to detect slippage.
5. **Version snapshots** record the plan at each status date. Comparing consecutive snapshots reveals which tasks slipped (end_date pushed), which were added/removed, and overall schedule drift.

## Dependency Cascade Analysis

Dependencies define execution order. When a task slips, you MUST trace downstream impact:

- **FS (Finish-to-Start, type=2)**: B starts after A finishes. If A's end_date pushes by N days, B's start must also push by N days (and B's end pushes too, preserving duration). This cascades to B's successors.
- **SS (Start-to-Start, type=0)**: B starts when A starts. If A's start pushes, B's start pushes.
- **FF (Finish-to-Finish, type=3)**: B finishes when A finishes. If A's end pushes, B's end pushes.
- **SF (Start-to-Finish, type=1)**: B finishes when A starts. If A's start pushes, B's end pushes.
- **Lag**: Each dependency can have a lag (days). The successor is offset by lag days after the dependency condition.

**How to analyze cascade impact:**
1. When you see a task with end_date pushed (from version diffs), find all its successors in the Dependencies list.
2. For each successor, check if its dates also shifted by the same amount — if yes, it was cascaded.
3. Trace the full chain until you reach tasks with no successors (leaf tasks / milestones).
4. The last tasks in the chain determine the **project end date impact**. If a leaf/milestone end_date shifted, the overall project timeline shifted by that amount.
5. Report the cascade chain: "任务A延期N天 → 任务B(FS) → 任务C(FS) → 里程碑X，导致项目整体延期N天"

**Critical path**: The longest chain of dependent tasks determines the project duration. When summarizing, identify whether slipped tasks are on the critical path (i.e., their delay directly affects the project end date).

When analyzing progress:
- **判定任务"延期"的规则**：对每个任务比较 end_date vs baseline_end_date（即任务行中的 baseline_end 列）；若 end > baseline_end（或 delay_flag="延期"），则该任务为"延期"。这个判定在"确认变更"后会持续，直到下一期重置基线。
- "延期" / "滞后" / "slipped" = task end_date was pushed later vs previous version
- "提前" / "ahead" = task end_date was pulled earlier vs previous version
- Do NOT report tasks as "overdue" just because %done < 100 — only if their end_date was extended at a status date check
- Always trace dependency chains to report total project impact, not just individual task delays

## Between-Status-Dates Change Detection (关键规则)

When the user asks about progress between two status dates (or "本期变化"、"上期对比"、"相邻版本对比" 等类似问题)：

1. **First, diff the task end_dates** between the two version snapshots:
   - If **NO task's end_date changed** between the two versions → respond concisely with:
     **"计划不变，工期不变"** (plan unchanged, duration unchanged).
     Do NOT fabricate risks, do NOT list tasks, do NOT perform cascade analysis. End the response there.
   - If **one or more end_dates changed** → FIRST analyze duration/schedule impact:
     a. List each task whose end_date changed, with old → new and Δ days.
     b. Trace each slipped task's dependency chain to identify downstream impact.
     c. Report overall project end-date shift (sum of critical-path impact).
     d. Only after the duration analysis, mention other field changes (assignee, %done etc.) if relevant.

2. The end_date diff is the **primary signal**. Changes in name/assignee/note without any end_date change still count as "计划不变，工期不变" for scheduling purposes — but you may briefly note them as "非工期变更" if the user asked broadly.
3. Ignore percent_done changes for planning analysis. percent_done is derived from status_date and is reference-only.

Rules:
- When creating tasks, provide name. start_date/end_date/duration are optional but recommended (YYYY-MM-DD).
- When the user refers to a task by name or code, match from the context above.
- For ambiguous references, ask the user to clarify.
- Respond in the same language the user uses.
- For pure questions (e.g. "which tasks are late?"), answer with text — no tool calls needed.
- You may call multiple tools in one response for batch operations.
- Use task_code (not internal id) when referencing tasks.
- **IMPORTANT — Summarizing progress or changes:** When the user asks to "总结进展", "总结本周", "项目进展", "weekly summary", or any variation about project progress / change summary:
  1. Call get_task_changes for the requested reporting period:
     - 周报/本周/weekly: from_date="${previousWeek}", to_date="${today}"（提交当天到前一周）
     - 月报/本月/monthly: from_date="${previousMonth}", to_date="${today}"（提交当天到前一月）
     - 未指定周期: default to from_date="${previousWeek}", to_date="${today}"
     Include new tasks, deleted tasks, and field modifications.
  2. Also call get_version_diffs to get version snapshot diffs (what changed between status date confirmations).
  3. Choose the final output format from the reporting period:
     - **周报/本周/weekly（最高优先级）**：${WEEKLY_SUMMARY_OUTPUT_REQUIREMENT}
     - **月报、本月或未明确要求周报的其他进展总结**：Combine both results into a structured summary. 输出顺序严格按照以下结构，必须先分析工期/计划，再分析新增删除和依赖关系；完成百分比只能放在参考信息里；第一句必须直接给出完工日期结论：

       开头第一句只能使用以下三类表达之一：
       - **完工日期不变**
       - **完工日期推迟到YYYY-MM-DD**
       - **完工日期提前到YYYY-MM-DD**

       ### 一、工期和计划变更（优先）
       - **项目整体工期影响**：比较最新两个版本，量化项目结束日期/关键里程碑的偏移天数（延期N天 / 提前N天 / 无变化）。如果系统上下文已提供"项目完工日期对比/结论"，必须优先采用该结论。
       - **延期任务清单**：只挑重点列出 end_date 被推后的任务，给出 old → new 和 Δ天数，并引用 delay_flag 字段；优先选择关键路径、影响下游、影响里程碑或延期幅度大的任务。
       - **提前任务清单**：只挑重点列出 end_date 被提前的任务（如有）。
       - **级联影响分析**：对每个延期任务，沿依赖关系追踪下游受影响任务，写出完整链路。示例："任务A(T-005)延期3天 → FS → 任务B(T-006) → FS → 里程碑(T-010)，项目整体工期延期3天"。

       ### 二、新增、删除和任务审计
       - **新增任务**：挑重点列出本期新建任务，引用任务创建时间 created/审计记录时间；优先列出影响计划、里程碑、关键路径或资源安排的新增任务。
       - **删除任务**：列出本期删除任务及审计记录时间。
       - **任务字段变更**：仅列出会影响计划或管理的信息，例如名称、开始/结束、工期、负责人、里程碑、父任务、顺序；不要把 percent_done 作为核心变更，不要流水账罗列低重要性字段。

       ### 三、依赖关系变化
       - 列出新增、删除、修改的依赖关系，包括依赖类型和 lag。
       - 说明这些依赖变化是否造成下游任务日期变化或关键路径影响。

       ### 四、参考信息
       - 可简要给出状态日期和自动计算的整体进度百分比。
       - 明确说明完成百分比是由状态日期推算出的参考值，不作为任务工期变动判断依据。

     对于非周报总结，若本期"计划不变、工期不变"（参见上面的判定规则），第一段直接写"本期计划不变，工期不变"即可，仍需继续列出新增/删除任务和依赖关系变化（如有）。
  You MUST call both tools in parallel in one response, then synthesize the final answer in the selected output format.
- When the user asks about version comparison or what changed between status dates, use get_version_diffs.
- Today is ${today}. Default weekly progress-summary range: ${previousWeek} ~ ${today} (提交当天到前一周). Monthly progress-summary range: ${previousMonth} ~ ${today} (提交当天到前一月).`
}
