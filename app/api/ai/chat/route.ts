import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { getAuthUser } from '@/lib/middleware'
import { failure } from '@/lib/result'
import { AI_TOOLS, buildSystemPrompt, type VersionChangesSummary } from '@/lib/ai/tools'
import {
  getReasoningContentLength,
  hasRenderableAssistantOutput,
  positiveIntegerOrDefault,
  resolveAiThinkingMode,
  type AiThinkingMode,
} from '@/lib/ai/chatPolicy'
import type { Task, Dependency } from '@/types'

const openaiBaseURL = process.env.OPENAI_BASE_URL || undefined
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4o'
const aiTimeoutMs = positiveIntegerOrDefault(process.env.OPENAI_TIMEOUT_MS, 60_000)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  baseURL: openaiBaseURL,
  timeout: aiTimeoutMs,
})

type CompatibleChatParams = ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: AiThinkingMode }
}

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(failure('OPENAI_API_KEY not configured', 500), { status: 500 })
  }

  const body = await req.json()
  const { projectName, messages, tasks, dependencies, versionChanges, statusDate, progress, prevTaskIds, isMinute } = body as {
    projectName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[]
    tasks: Task[]
    dependencies: Dependency[]
    versionChanges?: VersionChangesSummary[]
    statusDate?: string | null
    progress?: number | null
    prevTaskIds?: string[]
    isMinute?: boolean
  }

  const systemPrompt = buildSystemPrompt(
    projectName, tasks, dependencies, versionChanges, statusDate, progress, prevTaskIds,
    isMinute ?? true,
  )

  try {
    const apiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ]

    const requestParams: CompatibleChatParams = {
      model: openaiModel,
      messages: apiMessages,
      tools: AI_TOOLS,
      temperature: 0.3,
      max_tokens: 4096,
    }
    const thinkingMode = resolveAiThinkingMode(
      openaiBaseURL,
      openaiModel,
      process.env.OPENAI_THINKING_MODE,
    )
    if (thinkingMode) requestParams.thinking = { type: thinkingMode }

    const startedAt = Date.now()
    const response = await openai.chat.completions.create(requestParams)

    const choice = response.choices[0]
    if (!choice || !hasRenderableAssistantOutput(choice.message)) {
      console.error('AI chat returned no renderable output', {
        model: openaiModel,
        requestId: response._request_id ?? null,
        finishReason: choice?.finish_reason ?? null,
        completionTokens: response.usage?.completion_tokens ?? null,
        reasoningContentLength: getReasoningContentLength(choice?.message),
        elapsedMs: Date.now() - startedAt,
      })
      return NextResponse.json(
        failure('AI 未返回可显示内容，请重试', 502),
        { status: 502 },
      )
    }
    return NextResponse.json({
      ok: true,
      value: {
        message: choice.message,
        usage: response.usage,
      },
    })
  } catch (err) {
    console.error('AI chat error:', err)
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const timedOut = /timeout|timed out|aborted/i.test(msg)
    const userMessage = timedOut ? 'AI 请求超时，请稍后重试' : 'AI 请求失败，请稍后重试'
    return NextResponse.json(failure(userMessage, timedOut ? 504 : 500), {
      status: timedOut ? 504 : 500,
    })
  }
}
