'use client'

import type { AttributeQueryReport } from '@/lib/ai/taskAttributeQuery'

export default function AIAttributeReport({ report, unsaved }: { report: AttributeQueryReport; unsaved: boolean }) {
  const { query, attribute, skipped } = report
  const unit = query.operation === 'count' ? '个任务' : attribute.unit
  const groupLabel = query.group_by === 'month' ? '月份' : query.group_by === 'year' ? '年份' : query.group_by === 'assignee' ? '责任人' : '范围'
  const detailRows = <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs">
    <thead><tr className="border-b border-gray-200 text-gray-500"><th className="py-2 pr-2">任务</th><th className="py-2 pr-2">日期</th><th className="py-2 text-right">属性值{attribute.unit ? `（${attribute.unit}）` : ''}</th></tr></thead>
    <tbody>{report.details.map(row => <tr key={row.taskId} className="border-b border-gray-100">
      <td className="max-w-40 break-words py-2 pr-2">{row.taskName}</td><td className="py-2 pr-2 whitespace-nowrap">{row.date ?? '未设置'}</td><td className="max-w-40 break-all py-2 text-right tabular-nums">{row.value}</td>
    </tr>)}</tbody>
  </table></div>
  return <section data-ai-attribute-report={attribute.name} aria-label={`${attribute.name}查询结果`} className="mt-3 space-y-2 whitespace-normal rounded-lg border border-gray-200 bg-white p-3 text-xs">
    <p className="font-medium text-gray-900">{attribute.name}{query.operation === 'sum' ? '合计' : query.operation === 'count' ? '任务计数' : '明细'}</p>
    <p className="leading-relaxed text-gray-500">按{report.dateBasis}{query.group_by === 'month' ? '所在自然月' : query.group_by === 'year' ? '所在自然年' : ''}统计{query.group_by === 'month' ? '，跨月任务整笔计入该月' : ''}。{query.from_date || query.to_date ? `日期范围：${query.from_date ?? '不限'} 至 ${query.to_date ?? '不限'}。` : '日期范围：全计划。'}</p>
    {query.operation === 'list' ? detailRows : <div className="max-h-72 overflow-auto"><table className="w-full text-left text-xs">
      <thead><tr className="border-b border-gray-200 text-gray-500"><th className="py-2 pr-2">{groupLabel}</th><th className="py-2 text-right">{query.operation === 'count' ? '任务数' : `汇总值${unit ? `（${unit}）` : ''}`}</th>{query.operation !== 'count' && <th className="py-2 pl-2 text-right">任务数</th>}</tr></thead>
      <tbody>{report.groups.map(group => <tr key={group.key} data-ai-group={group.key} className="border-b border-gray-100"><td className="py-2 pr-2">{group.key}</td><td data-ai-value={group.value} className="break-all py-2 text-right tabular-nums">{group.value}</td>{query.operation !== 'count' && <td className="py-2 pl-2 text-right">{group.tasks}</td>}</tr>)}</tbody>
      <tfoot><tr className="font-semibold text-blue-700"><td className="py-2">合计</td><td data-ai-total={report.total ?? ''} className="break-all py-2 text-right tabular-nums">{report.total}</td>{query.operation !== 'count' && <td className="py-2 pl-2 text-right">{report.matchedTasks}</td>}</tr></tfoot>
    </table></div>}
    {report.matchedTasks === 0 && <p className="text-amber-700">没有符合条件的已填记录，不能据此认定实际发生量为零。</p>}
    {(skipped.empty > 0 || skipped.invalid > 0 || skipped.missingDate > 0) && <p className="leading-relaxed text-amber-700">未纳入：未填属性 {skipped.empty} 项、无效值 {skipped.invalid} 项、缺少有效日期 {skipped.missingDate} 项。未填值不当作 0。</p>}
    <p className="leading-relaxed text-gray-500">{report.scope}。{skipped.summary + skipped.inactive + skipped.archived > 0 ? `已排除摘要 ${skipped.summary} 项、无效任务 ${skipped.inactive} 项、停用属性 ${skipped.archived} 项。` : ''}</p>
    {report.warnings.map(warning => <p key={warning} className="text-amber-700">{warning}</p>)}
    <p className="text-gray-500">数据：提问时的当前计划{unsaved ? '，包含尚未保存的修改' : ''}。查询不会修改或保存任务。</p>
    {query.operation !== 'list' && report.details.length > 0 && <details><summary className="cursor-pointer text-blue-600">查看纳入统计的任务</summary>{detailRows}</details>}
    {report.detailsTruncated && <p className="text-gray-500">明细仅显示前 100 项；合计已计算全部 {report.matchedTasks} 项。</p>}
  </section>
}
