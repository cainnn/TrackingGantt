export type AiThinkingMode = 'enabled' | 'disabled'

interface AssistantOutputLike {
  content?: unknown
  tool_calls?: unknown
  reasoning_content?: unknown
}

function isBigModelUrl(baseURL?: string): boolean {
  if (!baseURL) return false
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    return hostname === 'bigmodel.cn' || hostname.endsWith('.bigmodel.cn')
  } catch {
    return false
  }
}

/**
 * GLM-5 enables deep thinking by default. For interactive chat this can consume
 * the entire output budget before any displayable content is produced, so the
 * BigModel-compatible provider defaults to disabled unless explicitly overridden.
 */
export function resolveAiThinkingMode(
  baseURL: string | undefined,
  model: string,
  configuredMode?: string,
): AiThinkingMode | undefined {
  const normalized = configuredMode?.trim().toLowerCase()
  if (normalized === 'enabled' || normalized === 'disabled') return normalized

  if (isBigModelUrl(baseURL) && /^glm(?:-|$)/i.test(model.trim())) {
    return 'disabled'
  }
  return undefined
}

export function hasRenderableAssistantOutput(message?: AssistantOutputLike | null): boolean {
  if (!message) return false
  const hasText = typeof message.content === 'string' && message.content.trim().length > 0
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  return hasText || hasToolCalls
}

export function getReasoningContentLength(message?: AssistantOutputLike | null): number {
  return typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0
}

export function positiveIntegerOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
