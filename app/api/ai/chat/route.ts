import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getAuthUser } from '@/lib/middleware'
import { failure } from '@/lib/result'
import { AI_TOOLS, buildSystemPrompt, type VersionChangesSummary } from '@/lib/ai/tools'
import type { Task, Dependency } from '@/types'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  baseURL: process.env.OPENAI_BASE_URL || undefined,
})

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(failure('OPENAI_API_KEY not configured', 500), { status: 500 })
  }

  const body = await req.json()
  const { projectName, messages, tasks, dependencies, versionChanges, statusDate, progress } = body as {
    projectName: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[]
    tasks: Task[]
    dependencies: Dependency[]
    versionChanges?: VersionChangesSummary[]
    statusDate?: string | null
    progress?: number | null
  }

  const systemPrompt = buildSystemPrompt(projectName, tasks, dependencies, versionChanges, statusDate, progress)

  try {
    const apiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ]

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: apiMessages,
      tools: AI_TOOLS,
      temperature: 0.3,
      max_tokens: 4096,
    })

    const choice = response.choices[0]
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
    return NextResponse.json(failure('AI request failed: ' + msg, 500), { status: 500 })
  }
}
