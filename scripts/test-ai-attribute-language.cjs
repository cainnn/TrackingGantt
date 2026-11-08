// Uses the configured AI provider with synthetic in-memory data only. No DB writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const appDir = process.env.AI_APP_DIR || path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(appDir, 'package.json'));
appRequire('@next/env').loadEnvConfig(appDir);
const OpenAI = appRequire('openai').default;
const lib = process.env.AI_LIB_ROOT || path.join(appDir, '.test-dist/lib');
const { AI_TOOLS, buildSystemPrompt } = require(path.join(lib, 'ai/tools.js'));
const { queryTaskAttributeReports, attributeQueryMessage } = require(path.join(lib, 'ai/taskAttributeQuery.js'));
const { resolveAiThinkingMode } = require(path.join(lib, 'ai/chatPolicy.js'));
const tasks = Array.from({ length: 240 }, (_, i) => ({ id: `task-${i}`, project_id: 'fixture', parent_id: null, task_code: String(i + 1),
  name: `搬迁批次${i + 1}`, start_date: '2025-12-01', end_date: i < 120 ? '2026-01-31' : '2026-02-28', duration: 1440, duration_unit: 'day',
  percent_done: 0, is_milestone: false, assignee: '测试人员', note: null, order_index: i, is_deleted: false, deleted_at: null, created_at: '', updated_at: '',
  custom_fields: [{ id: `count-${i}`, name: '搬迁服务器台数', type: 'number', unit: '台' }], custom_values: { [`count-${i}`]: i === 239 ? '1000' : '2' },
}));
for (const [index, money, unit] of [[0, '999999999999999999.99', '台'], [1, '0.02', '批']]) {
  tasks[index].custom_fields.push({ id: `money-${index}`, name: '支出金额', type: 'money', unit: '元' }, { id: `equipment-${index}`, name: '设备数量', type: 'number', unit });
  Object.assign(tasks[index].custom_values, { [`money-${index}`]: money, [`equipment-${index}`]: '3' });
}
async function main() {
  assert.ok(process.env.OPENAI_API_KEY, 'AI provider key is not configured');
  const baseURL = process.env.OPENAI_BASE_URL || undefined, model = process.env.OPENAI_MODEL || 'gpt-4o';
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL, timeout: 60000, maxRetries: 0 });
  const thinking = resolveAiThinkingMode(baseURL, model, process.env.OPENAI_THINKING_MODE);
  const cases = [
    ['统计每月搬迁服务器的台数，按结束日期，覆盖全部计划', result => {
      assert.equal(result.ok, true); assert.equal(result.query.date_field, 'end_date'); assert.equal(result.query.operation, 'sum'); assert.equal(result.query.group_by, 'month');
      assert.equal(result.total, '1478'); assert.equal(result.matchedTasks, 240);
      assert.deepEqual(result.groups, [{ key: '2026-01', value: '240', tasks: 120 }, { key: '2026-02', value: '1238', tasks: 120 }]);
    }],
    ['只看2026年1月份搬迁服务器台数的合计', result => { assert.equal(result.ok, true); assert.equal(result.total, '240'); assert.equal(result.matchedTasks, 120); }],
    ['按结束日期统计每月支出金额，覆盖全部计划', result => { assert.equal(result.ok, true); assert.equal(result.total, '1000000000000000000.01'); }],
    ['查询任务“搬迁批次240”的搬迁服务器台数', result => { assert.equal(result.ok, true); assert.equal(result.matchedTasks, 1); assert.equal(result.details[0].value, '1000'); }],
    ['每月汇总设备数量', (result, reports) => { assert.equal(reports.length, 2); assert.ok(reports.every(report => report.ok)); assert.deepEqual(reports.map(report => report.attribute.unit).sort(), ['台', '批']); assert.ok(reports.every(report => report.total === '3')); }],
    ['后3个月搬迁服务器数量有多少？请直接用文字回答', result => {
      assert.equal(result.ok, true); assert.equal(result.query.from_date, '2026-12-01'); assert.equal(result.query.to_date, '2027-02-28');
      const answer = attributeQueryMessage(result); assert.match(answer, /2026-12-01至2027-02-28/); assert.match(answer, /2027年2月/);
    }],
  ];
  for (const [text, check] of cases) {
    const started = Date.now();
    const response = await client.chat.completions.create({ model, temperature: 0.3, max_tokens: 1024,
      messages: [{ role: 'system', content: buildSystemPrompt('AI自然语言专用验收', tasks, [], undefined, '2026-01-15', 0, undefined, false, [], '2026-11-08') }, { role: 'user', content: text }],
      tools: AI_TOOLS.filter(tool => tool.function.name === 'query_task_attributes'),
      tool_choice: { type: 'function', function: { name: 'query_task_attributes' } }, ...(thinking ? { thinking: { type: thinking } } : {}),
    });
    const calls = response.choices[0]?.message.tool_calls;
    assert.ok(calls?.length, 'Provider must return a real attribute tool call');
    assert.equal(calls[0].function.name, 'query_task_attributes');
    const args = JSON.parse(calls[0].function.arguments), reports = queryTaskAttributeReports(tasks, args, [], { text, today: '2026-11-08' }), result = reports[0];
    check(result, reports);
    console.log(JSON.stringify({ passed: true, prompt: text, query: args, total: result.total ?? null, elapsedMs: Date.now() - started }));
  }
  console.log(JSON.stringify({ passed: true, cases: cases.length, taskCount: tasks.length, mode: 'real-provider', databaseWrites: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
