'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addTasks, updateTasks, deleteTasks,
  addDependency, removeDependency,
} from '@/store/slices/tasksSlice'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { computeProjectProgressPercent } from '@/lib/projectProgress'
import { runFullCascade } from '@/lib/clientScheduling'
import { uuid } from '@/lib/uuid'
import { markDirty } from '@/store/slices/tasksSlice'
import type { Task, Dependency } from '@/types'

// ── Types ────────────────────────────────────────────────────────────────────
interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

interface ChatMsg {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  actions?: string[]  // UI-only: show action summaries
}

interface Props {
  projectId: string
  onClose: () => void
  autoMessage?: string | null
  onAutoMessageConsumed?: () => void
}

// ── Helper: resolve task_code → id ───────────────────────────────────────────
function codeToId(tasks: Task[], code: string): string | null {
  return tasks.find(t => t.task_code === code)?.id ?? null
}

export default function AIChatPanel({ projectId, onClose, autoMessage, onAutoMessageConsumed }: Props) {
  const dispatch = useAppDispatch()
  const { tasks, dependencies, diffFilter, comparison } = useAppSelector(s => s.tasks)
  const { versions } = useAppSelector(s => s.versions)
  const currentProject = useAppSelector(s => s.project.currentProject)

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const diffSentRef = useRef<string | null>(null)  // 记录已自动发送过的版本名

  // ── 上一次状态日期快照的 end_date + ID 集合 ────────────────────────
  // end_date 用于覆盖 baseline_end_date；ID 集合用于 AI 识别"本期新增任务"作为延期根源
  const [prevSnapshotEnds, setPrevSnapshotEnds] = useState<Map<string, string>>(new Map())
  const [prevSnapshotTaskIds, setPrevSnapshotTaskIds] = useState<string[]>([])
  useEffect(() => {
    const snapshots = versions.filter(v => !v.is_autosave && v.status_date)
    const baseline = snapshots.length >= 2 ? snapshots[1] : snapshots[0]
    if (!baseline) {
      setPrevSnapshotEnds(new Map())
      setPrevSnapshotTaskIds([])
      return
    }
    let cancelled = false
    authFetch(`/api/versions/${projectId}?id=${baseline.id}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.ok && Array.isArray(d.value?.snapshot?.tasks)) {
          const m = new Map<string, string>()
          const ids: string[] = []
          for (const t of d.value.snapshot.tasks as { id: string; end_date: string | null }[]) {
            ids.push(t.id)
            if (t.end_date) m.set(t.id, String(t.end_date).split('T')[0])
          }
          setPrevSnapshotEnds(m)
          setPrevSnapshotTaskIds(ids)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, versions])

  // 用上期状态日期快照的 end_date 覆盖 baseline_end_date，确保 AI 收到的是"最近 2 次状态日期快照"的真实差异
  const enrichedTasks = React.useMemo(() => {
    if (prevSnapshotEnds.size === 0) return tasks
    return tasks.map(t => {
      const be = prevSnapshotEnds.get(t.id)
      return be ? { ...t, baseline_end_date: be } : t
    })
  }, [tasks, prevSnapshotEnds])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // ── Execute tool calls ──────────────────────────────────────────────────
  const executeToolCalls = useCallback(async (toolCalls: ToolCall[]): Promise<{ id: string; result: string }[]> => {
    const results: { id: string; result: string }[] = []

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function.arguments)
      let result = ''

      try {
        switch (tc.function.name) {
          case 'create_task': {
            const parentId = args.parent_task_code ? codeToId(tasks, args.parent_task_code) : null
            const maxCode = tasks.reduce((m, t) => {
              const n = parseInt(t.task_code, 10)
              return !isNaN(n) && n > m ? n : m
            }, 0)
            const newTask: Task = {
              id: uuid(),
              project_id: projectId,
              task_code: String(maxCode + 1),
              name: args.name,
              parent_id: parentId,
              assignee: args.assignee ?? null,
              start_date: args.start_date ?? null,
              end_date: args.end_date ?? null,
              duration: args.duration ?? null,
              duration_unit: 'day',
              percent_done: 0,
              is_milestone: args.is_milestone ?? false,
              note: args.note ?? null,
              order_index: tasks.filter(t => t.parent_id === parentId).length,
              auto_schedule: true,
              constraint_type: 'asap',
              constraint_date: null,
              status: null,
              rollup: false,
              inactive: false,
              project_boundary: 'ask',
              baseline_end_date: null,
              original_start_date: null,
              original_end_date: null,
              deadline: null,
              is_deleted: false,
              deleted_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
            dispatch(addTasks([newTask]))
            dispatch(markDirty([newTask.id]))
            result = `Created task "${args.name}" (code: ${newTask.task_code})`
            break
          }

          case 'update_task': {
            const id = codeToId(tasks, args.task_code)
            if (!id) { result = `Task code "${args.task_code}" not found`; break }
            const updates: Record<string, unknown> = {}
            for (const key of ['name', 'start_date', 'end_date', 'duration', 'assignee', 'percent_done', 'is_milestone', 'note']) {
              if (args[key] !== undefined) updates[key] = args[key]
            }
            const task = tasks.find(t => t.id === id)
            if (task) {
              const updated = { ...task, ...updates } as Task
              dispatch(updateTasks([updated]))
              dispatch(markDirty([id]))
              const cascaded = runFullCascade(
                tasks.map(t => t.id === id ? updated : t),
                dependencies,
              )
              if (cascaded.length > 0) {
                dispatch(updateTasks(cascaded))
                dispatch(markDirty(cascaded.map(t => t.id)))
              }
            }
            result = `Updated task ${args.task_code}: ${Object.keys(updates).join(', ')}`
            break
          }

          case 'delete_tasks': {
            const ids = (args.task_codes as string[]).map(c => codeToId(tasks, c)).filter(Boolean) as string[]
            if (ids.length === 0) { result = 'No matching tasks found'; break }
            const idSet = new Set(ids)
            const relatedDeps = dependencies.filter(d => idSet.has(d.from_task_id) || idSet.has(d.to_task_id))
            for (const d of relatedDeps) dispatch(removeDependency(d.id))
            dispatch(deleteTasks(ids))
            const remainTasks = tasks.filter(t => !idSet.has(t.id))
            const remainDeps = dependencies.filter(d => !relatedDeps.some(x => x.id === d.id))
            const cascaded = runFullCascade(remainTasks, remainDeps)
            if (cascaded.length > 0) {
              dispatch(updateTasks(cascaded))
              dispatch(markDirty(cascaded.map(t => t.id)))
            }
            result = `Deleted ${ids.length} task(s)`
            break
          }

          case 'add_dependency': {
            const fromId = codeToId(tasks, args.from_task_code)
            const toId   = codeToId(tasks, args.to_task_code)
            if (!fromId || !toId) { result = `Task code not found`; break }
            const newDep: Dependency = {
              id: uuid(),
              project_id: projectId,
              from_task_id: fromId,
              to_task_id: toId,
              type: args.type ?? 2,
              lag: args.lag ?? 0,
              active: true,
            }
            dispatch(addDependency(newDep))
            const cascaded = runFullCascade(tasks, [...dependencies, newDep])
            if (cascaded.length > 0) {
              dispatch(updateTasks(cascaded))
              dispatch(markDirty(cascaded.map(t => t.id)))
            }
            result = `Added dependency ${args.from_task_code} -> ${args.to_task_code}`
            break
          }

          case 'remove_dependency': {
            const fromId = codeToId(tasks, args.from_task_code)
            const toId   = codeToId(tasks, args.to_task_code)
            if (!fromId || !toId) { result = `Task code not found`; break }
            const dep = dependencies.find(d => d.from_task_id === fromId && d.to_task_id === toId)
            if (!dep) { result = `Dependency not found`; break }
            dispatch(removeDependency(dep.id))
            const remainDeps = dependencies.filter(d => d.id !== dep.id)
            const cascaded = runFullCascade(tasks, remainDeps)
            if (cascaded.length > 0) {
              dispatch(updateTasks(cascaded))
              dispatch(markDirty(cascaded.map(t => t.id)))
            }
            result = `Removed dependency ${args.from_task_code} -> ${args.to_task_code}`
            break
          }

          case 'get_task_changes': {
            const res = await authFetch(
              `/api/tasks/${projectId}/changelog?from=${args.from_date}&to=${args.to_date}`,
            )
            const data = await res.json()
            if (data.ok) {
              const { events, summary } = data.value
              // Format for LLM consumption
              const lines: string[] = [`变更记录 (${args.from_date} ~ ${args.to_date}), 共 ${events.length} 条:`]
              for (const [code, info] of Object.entries(summary) as [string, { task_code: string; changes: { field: string; old: string; new: string; at: string }[]; created: boolean; deleted: boolean }][]) {
                if (info.created) lines.push(`  [新建] 任务 ${code}`)
                if (info.deleted) lines.push(`  [删除] 任务 ${code}`)
                for (const c of info.changes) {
                  lines.push(`  任务 ${code}: ${c.field} "${c.old}" → "${c.new}"`)
                }
              }
              if (events.length === 0) lines.push('  该时间段内没有任何变更记录。')
              result = lines.join('\n')
            } else {
              result = `Failed: ${data.error}`
            }
            break
          }

          case 'get_version_diffs': {
            const versionId = args.version_id as string | undefined
            const limit = Math.min(Number(args.limit) || 5, 20)
            let url = `/api/versions/${projectId}?list=1`
            const res = await authFetch(url)
            const data = await res.json()
            if (data.ok) {
              type VersionRow = { id: string; version_number: number; name: string; status_date: string | null; created_at: string; changes: { diffs: { task_code: string; task_name: string; type: string; changes?: { field: string; old: string; new: string }[] }[]; stats: { added: number; removed: number; changed: number } } | null }
              let versions = data.value as VersionRow[]
              if (versionId) {
                versions = versions.filter((v: VersionRow) => v.id === versionId)
              } else {
                versions = versions.slice(0, limit)
              }
              const lines: string[] = []
              for (const v of versions) {
                lines.push(`\n版本 #${v.version_number} "${v.name}" (${v.status_date || v.created_at.split('T')[0]}):`)
                if (!v.changes) {
                  lines.push('  (首个版本，无变更记录)')
                  continue
                }
                const { stats, diffs } = v.changes
                lines.push(`  统计: 新增${stats.added} 修改${stats.changed} 删除${stats.removed}`)
                for (const d of diffs) {
                  if (d.type === 'added') lines.push(`  [新增] ${d.task_code} ${d.task_name}`)
                  else if (d.type === 'removed') lines.push(`  [删除] ${d.task_code} ${d.task_name}`)
                  else if (d.type === 'changed' && d.changes) {
                    for (const c of d.changes) {
                      lines.push(`  ${d.task_code} ${d.task_name}: ${c.field} "${c.old}" → "${c.new}"`)
                    }
                  }
                }
              }
              if (lines.length === 0) lines.push('没有找到版本记录。')
              result = lines.join('\n')
            } else {
              result = `Failed: ${data.error}`
            }
            break
          }

          case 'bulk_update_tasks': {
            const updates = args.updates as Record<string, unknown>
            const ids = (args.task_codes as string[]).map(c => codeToId(tasks, c)).filter(Boolean) as string[]
            if (ids.length === 0) { result = 'No matching tasks found'; break }
            const idSet = new Set(ids)
            const updatedTasks = tasks
              .filter(t => idSet.has(t.id))
              .map(t => ({ ...t, ...updates } as Task))
            dispatch(updateTasks(updatedTasks))
            dispatch(markDirty(ids))
            const nextTasks = tasks.map(t => updatedTasks.find(u => u.id === t.id) ?? t)
            const cascaded = runFullCascade(nextTasks, dependencies)
            if (cascaded.length > 0) {
              dispatch(updateTasks(cascaded))
              dispatch(markDirty(cascaded.map(t => t.id)))
            }
            result = `Updated ${ids.length} task(s): ${Object.keys(updates).join(', ')}`
            break
          }

          default:
            result = `Unknown tool: ${tc.function.name}`
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : 'Unknown'}`
      }

      results.push({ id: tc.id, result })
    }

    return results
  }, [tasks, dependencies, projectId, dispatch])

  // ── 检测"总结进展"类意图的关键词 ─────────────────────────────────────────
  const isSummaryIntent = (text: string) =>
    /总结|进展|周报|月报|汇报|summary|progress|本周|本月|变更情况|工作总结/.test(text)

  // ── 根据用户消息推断查询日期范围 ──────────────────────────────────────────
  const inferDateRange = (text: string): { from: string; to: string; label: string } => {
    const today = new Date()
    const fmt = (d: Date) => d.toISOString().split('T')[0]
    if (/本月|月报|this month/i.test(text)) {
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: fmt(monthStart), to: fmt(today), label: '本月' }
    }
    // 默认本周
    const monday = new Date(today)
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
    return { from: fmt(monday), to: fmt(today), label: '本周' }
  }

  // ── 前端主动预取变更数据 ──────────────────────────────────────────────────
  const prefetchChanges = useCallback(async (text: string): Promise<string> => {
    const { from, to, label } = inferDateRange(text)

    // 并行获取变更记录 + 版本差异
    const [changelogRes, versionRes] = await Promise.all([
      authFetch(`/api/tasks/${projectId}/changelog?from=${from}&to=${to}`).then(r => r.json()).catch(() => null),
      authFetch(`/api/versions/${projectId}?list=1`).then(r => r.json()).catch(() => null),
    ])

    const lines: string[] = []

    // 变更记录
    lines.push(`\n【任务变更记录 ${label} ${from} ~ ${to}】`)
    if (changelogRes?.ok) {
      const { events, summary } = changelogRes.value
      if (events.length === 0) {
        lines.push('该时间段内没有任何变更记录。')
      } else {
        lines.push(`共 ${events.length} 条变更：`)
        for (const [code, info] of Object.entries(summary) as [string, { task_code: string; changes: { field: string; old: string; new: string }[]; created: boolean; deleted: boolean }][]) {
          if (info.created) lines.push(`  [新建] 任务 ${code}`)
          if (info.deleted) lines.push(`  [删除] 任务 ${code}`)
          for (const c of info.changes) {
            lines.push(`  任务 ${code}: ${c.field} "${c.old}" → "${c.new}"`)
          }
        }
      }
    } else {
      lines.push('(获取变更记录失败)')
    }

    // 版本差异
    lines.push(`\n【版本快照差异（最近5个版本）】`)
    if (versionRes?.ok && Array.isArray(versionRes.value)) {
      type VR = { version_number: number; name: string; status_date: string | null; changes: { diffs: { task_code: string; task_name: string; type: string; changes?: { field: string; old: string; new: string }[] }[]; stats: { added: number; removed: number; changed: number } } | null }
      const recentVersions = (versionRes.value as VR[]).slice(0, 5)
      if (recentVersions.length === 0) {
        lines.push('暂无版本快照。')
      }
      for (const v of recentVersions) {
        lines.push(`版本 #${v.version_number} "${v.name}" (状态日期: ${v.status_date ?? '未知'}):`)
        if (!v.changes) { lines.push('  (首个版本，无变更)'); continue }
        lines.push(`  统计: 新增${v.changes.stats.added} 修改${v.changes.stats.changed} 删除${v.changes.stats.removed}`)
        for (const d of v.changes.diffs) {
          if (d.type === 'added') lines.push(`  [新增] ${d.task_code} ${d.task_name}`)
          else if (d.type === 'removed') lines.push(`  [删除] ${d.task_code} ${d.task_name}`)
          else if (d.type === 'changed' && d.changes) {
            for (const c of d.changes) lines.push(`  ${d.task_code} ${d.task_name}: ${c.field} "${c.old}" → "${c.new}"`)
          }
        }
      }
    } else {
      lines.push('(获取版本差异失败)')
    }

    // 整体状态
    const progress = computeProjectProgressPercent(tasks, currentProject?.status_date)
    lines.push(`\n【项目状态】`)
    lines.push(`项目名称: ${currentProject?.name ?? '未知'}`)
    lines.push(`状态日期: ${currentProject?.status_date?.split('T')[0] ?? '未设置'}`)
    lines.push(`整体进度: ${progress}%`)
    const overdue = tasks.filter(t => !t.is_deleted && t.end_date && new Date(t.end_date) < new Date() && (t.percent_done ?? 0) < 100)
    if (overdue.length > 0) {
      lines.push(`逾期任务 (${overdue.length}个): ${overdue.slice(0, 10).map(t => `${t.task_code} ${t.name}`).join(', ')}`)
    }

    return lines.join('\n')
  }, [projectId, tasks, currentProject])

  // ── Send message ────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (directText?: string) => {
    const text = (directText ?? input).trim()
    if (!text || loading) return

    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    if (!directText) setInput('')
    setLoading(true)

    try {
      // 如果是"总结进展"类意图，前端主动预取数据注入上下文
      let enrichedMessages = newMessages
      if (isSummaryIntent(text)) {
        const changeData = await prefetchChanges(text)
        // 将变更数据作为附加上下文拼接到用户消息中
        enrichedMessages = [
          ...messages,
          { role: 'user' as const, content: `${text}\n\n--- 以下是系统自动获取的变更数据，请基于此数据进行总结分析 ---\n${changeData}` },
        ]
      }

      // Build API messages (strip UI-only fields)
      const apiMessages = enrichedMessages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
        return msg
      })

      // 构建版本变更摘要（最近几个版本的 changes）
      const versionChanges = versions
        .filter(v => v.changes?.diffs?.length)
        .slice(0, 5)
        .map(v => ({
          name: v.name || `快照 #${v.version_number}`,
          status_date: v.status_date,
          stats: v.changes!.stats,
          diffs: v.changes!.diffs,
        }))

      const res = await authFetch('/api/ai/chat', {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify({
          projectName: currentProject?.name ?? '',
          messages: apiMessages,
          tasks: enrichedTasks,
          dependencies,
          versionChanges,
          statusDate: currentProject?.status_date ?? null,
          progress: computeProjectProgressPercent(tasks, currentProject?.status_date),
          prevTaskIds: prevSnapshotTaskIds,
        }),
      })

      const data = await res.json()
      if (!data.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
        return
      }

      const assistantMsg: AssistantMessage = data.value.message

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        // Execute tool calls
        const toolResults = await executeToolCalls(assistantMsg.tool_calls)
        const actionSummaries = toolResults.map(r => r.result)

        // Add assistant message (with tool_calls info) and tool results to conversation
        const toolMessages: ChatMsg[] = toolResults.map(r => ({
          role: 'tool' as const,
          content: r.result,
          tool_call_id: r.id,
        }))

        // Send tool results back to LLM for a follow-up response
        const followUpMessages = [
          ...apiMessages,
          { role: 'assistant', content: assistantMsg.content ?? '', tool_calls: assistantMsg.tool_calls },
          ...toolMessages.map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id })),
        ]

        const followRes = await authFetch('/api/ai/chat', {
          method: 'POST',
          headers: authFetchHeaders(true),
          body: JSON.stringify({
            projectName: currentProject?.name ?? '',
            messages: followUpMessages,
            tasks: enrichedTasks,
            dependencies,
            versionChanges,
            prevTaskIds: prevSnapshotTaskIds,
          }),
        })
        const followData = await followRes.json()

        const followUpContent = followData.ok
          ? (followData.value.message.content ?? '')
          : 'Actions completed.'

        setMessages(prev => [...prev, {
          role: 'assistant',
          content: followUpContent,
          actions: actionSummaries,
        }])
      } else {
        // Pure text response
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: assistantMsg.content ?? '',
        }])
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, tasks, dependencies, versions, currentProject, executeToolCalls, prefetchChanges])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // ── Auto-send message from parent (confirm changes) ────────────────────
  const autoMsgProcessedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!autoMessage || loading) return
    if (autoMsgProcessedRef.current === autoMessage) return
    autoMsgProcessedRef.current = autoMessage
    sendMessage(autoMessage)
    onAutoMessageConsumed?.()
  }, [autoMessage, loading, sendMessage, onAutoMessageConsumed])

  // ── Auto-send diff analysis when diffFilter is active ────────────────────
  useEffect(() => {
    if (!diffFilter) { diffSentRef.current = null; return }
    if (loading) return
    // 已经为这个版本发送过了，不重复
    if (diffSentRef.current === diffFilter.versionName) return
    diffSentRef.current = diffFilter.versionName

    // 构建变更摘要文本
    const changedCodes = diffFilter.taskCodes
    if (changedCodes.length === 0) return

    // 从 comparison 中获取旧版本的任务数据，与当前任务对比，生成摘要
    const codeToTask = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.task_code, t]))
    const oldTaskByCode = new Map<string, Task>()
    if (comparison?.tasks) {
      for (const t of comparison.tasks) {
        if (t.task_code) oldTaskByCode.set(t.task_code, t)
      }
    }

    const lines: string[] = [`与版本「${diffFilter.versionName}」对比，共有 ${changedCodes.length} 个任务发生变更：`]
    for (const code of changedCodes) {
      const cur = codeToTask.get(code)
      const old = oldTaskByCode.get(code)
      if (cur && !old) {
        lines.push(`[新增] ${code} ${cur.name} (${cur.start_date?.split('T')[0] ?? '?'} ~ ${cur.end_date?.split('T')[0] ?? '?'}, 工期${cur.duration ?? '?'}天, 责任人: ${cur.assignee ?? '未分配'})`)
      } else if (!cur && old) {
        lines.push(`[删除] ${code} ${old.name}`)
      } else if (cur && old) {
        const diffs: string[] = []
        if (cur.name !== old.name) diffs.push(`名称: "${old.name}" → "${cur.name}"`)
        if (cur.start_date?.split('T')[0] !== old.start_date?.split('T')[0]) diffs.push(`开始: ${old.start_date?.split('T')[0] ?? '空'} → ${cur.start_date?.split('T')[0] ?? '空'}`)
        if (cur.end_date?.split('T')[0] !== old.end_date?.split('T')[0]) diffs.push(`结束: ${old.end_date?.split('T')[0] ?? '空'} → ${cur.end_date?.split('T')[0] ?? '空'}`)
        if (cur.duration !== old.duration) diffs.push(`工期: ${old.duration ?? '空'} → ${cur.duration ?? '空'}天`)
        if ((cur.assignee ?? '') !== (old.assignee ?? '')) diffs.push(`责任人: ${old.assignee || '未分配'} → ${cur.assignee || '未分配'}`)
        if (diffs.length > 0) lines.push(`[修改] ${code} ${cur.name}: ${diffs.join(', ')}`)
      }
    }

    const prompt = `请分析以下任务变更，指出关键变化、潜在风险和建议：\n\n${lines.join('\n')}`
    // 在后台发送（不阻塞用户输入）
    sendMessage(prompt)
  }, [diffFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Example prompts ─────────────────────────────────────────────────────
  const examples = [
    '总结本周进展',
    '总结本月进展',
    '哪些任务还没有分配责任人？',
    '把所有张三的任务改为李四负责',
    '创建一个任务"系统测试"，工期5天，开始于2026-04-01',
  ]

  return (
    <div className="relative z-30 flex flex-col h-full border-l border-gray-200 bg-white isolate" style={{ width: 400 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="text-sm font-semibold text-gray-800">AI 助手</span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-gray-500 mb-2">
              你好！我是 AI 助手，可以帮你管理甘特图中的任务。试试下面的例子：
            </p>
            <div className="space-y-2">
              {examples.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(ex) }}
                  className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700 transition-colors cursor-pointer"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.filter(m => m.role !== 'tool').map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-800'
            }`}>
              {msg.actions && msg.actions.length > 0 && (
                <div className="mb-2 space-y-1">
                  {msg.actions.map((a, j) => (
                    <div key={j} className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 rounded px-2 py-1">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="text-green-600 shrink-0">
                        <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                      </svg>
                      {a}
                    </div>
                  ))}
                </div>
              )}
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-xl px-4 py-2 text-sm text-gray-500">
              <span className="inline-flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            rows={1}
            className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            style={{ maxHeight: 120 }}
            onInput={e => {
              const el = e.target as HTMLTextAreaElement
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || loading}
            className="shrink-0 w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center disabled:opacity-40 hover:bg-blue-700 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
