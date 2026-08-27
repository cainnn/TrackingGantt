import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getReasoningContentLength,
  hasRenderableAssistantOutput,
  positiveIntegerOrDefault,
  resolveAiThinkingMode,
} from '../lib/ai/chatPolicy'

test('disables thinking by default for GLM on the BigModel provider', () => {
  assert.equal(
    resolveAiThinkingMode('https://open.bigmodel.cn/api/paas/v4/', 'glm-5'),
    'disabled',
  )
})

test('does not add provider-specific thinking settings for OpenAI by default', () => {
  assert.equal(resolveAiThinkingMode('https://api.openai.com/v1', 'gpt-4o'), undefined)
})

test('explicit thinking configuration overrides the provider default', () => {
  assert.equal(
    resolveAiThinkingMode('https://open.bigmodel.cn/api/paas/v4/', 'glm-5', 'enabled'),
    'enabled',
  )
  assert.equal(
    resolveAiThinkingMode('https://api.openai.com/v1', 'gpt-4o', 'disabled'),
    'disabled',
  )
})

test('reasoning-only responses are not considered renderable', () => {
  const message = { content: '', reasoning_content: 'internal analysis', tool_calls: [] }
  assert.equal(hasRenderableAssistantOutput(message), false)
  assert.equal(getReasoningContentLength(message), 17)
})

test('text or tool calls are considered renderable', () => {
  assert.equal(hasRenderableAssistantOutput({ content: '周报内容' }), true)
  assert.equal(hasRenderableAssistantOutput({ content: null, tool_calls: [{ id: 'call_1' }] }), true)
  assert.equal(hasRenderableAssistantOutput({ content: '   ', tool_calls: [] }), false)
})

test('AI timeout configuration accepts only positive integers', () => {
  assert.equal(positiveIntegerOrDefault('45000', 60_000), 45_000)
  assert.equal(positiveIntegerOrDefault('0', 60_000), 60_000)
  assert.equal(positiveIntegerOrDefault('invalid', 60_000), 60_000)
})
