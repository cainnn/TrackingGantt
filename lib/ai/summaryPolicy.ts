export const WEEKLY_SUMMARY_OUTPUT_REQUIREMENT =
  '周报最终回答必须只输出一句完整中文句子，以“完工日期不变”“完工日期推迟到YYYY-MM-DD”或“完工日期提前到YYYY-MM-DD”之一开头，紧接“本周主要完成工作：”，从本周达到结束日期、提前完成或推进到关键里程碑的任务中选1至3项并写出任务名称，再简述这些工作的工期影响和主要风险；不得把仅调整日期但尚未达到完成条件的任务写成已完成，若没有可靠数据可确认完成工作则写“本周主要完成工作：暂无可确认的完成工作”，不得猜测；若计划无变化则明确“本周计划不变，工期不变”；控制在180个汉字以内，不要标题、列表、表格、Markdown或换行，除“本周主要完成工作：”的冒号外，句内仅用逗号或分号连接并只在句末使用一个句号。'

export function isWeeklySummaryIntent(text: string): boolean {
  return /周报|本周|这周|上周|周总结|weekly|this week|last week/i.test(text)
}
