export const WEEKLY_SUMMARY_OUTPUT_REQUIREMENT =
  '周报最终回答必须只输出一句完整中文句子，以“完工日期不变”“完工日期推迟到YYYY-MM-DD”或“完工日期提前到YYYY-MM-DD”之一开头，在同一句中概括本周最关键的计划或工期变化及主要风险；若无变化则明确“本周计划不变，工期不变”；控制在120个汉字以内，不要标题、列表、表格、Markdown或换行，句内仅用逗号或分号连接并只在句末使用一个句号。'

export function isWeeklySummaryIntent(text: string): boolean {
  return /周报|本周|这周|上周|周总结|weekly|this week|last week/i.test(text)
}
