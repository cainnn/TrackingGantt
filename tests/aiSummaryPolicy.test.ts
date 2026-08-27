import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isWeeklySummaryIntent,
  WEEKLY_SUMMARY_OUTPUT_REQUIREMENT,
} from '../lib/ai/summaryPolicy'

test('recognizes explicit weekly summary requests', () => {
  assert.equal(isWeeklySummaryIntent('总结本周进展'), true)
  assert.equal(isWeeklySummaryIntent('生成项目周报'), true)
  assert.equal(isWeeklySummaryIntent('weekly summary'), true)
})

test('does not apply the one-sentence rule to monthly or generic summaries', () => {
  assert.equal(isWeeklySummaryIntent('总结本月进展'), false)
  assert.equal(isWeeklySummaryIntent('总结项目进展'), false)
})

test('weekly output policy separates completed work, schedule changes, and risks', () => {
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /只输出一句完整中文句子/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /本周主要完成工作：\{完成事项\}/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /工期变化：\{工期说明\}/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /主要风险：\{风险说明\}/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /任务名称/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /1至3项/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /不得在这里写工期变化、延期原因、下游影响、未完成工作或风险/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /工期说明单独写/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /风险说明单独写/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /不得猜测/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /180个汉字以内/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /不要标题、列表、表格、Markdown或换行/)
  assert.match(WEEKLY_SUMMARY_OUTPUT_REQUIREMENT, /只在句末使用一个句号/)
})
