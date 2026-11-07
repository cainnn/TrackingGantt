// Real HTTP export -> import roundtrip, with synthetic file data only; no project is modified.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.MPP_TEST_URL || process.argv[2] || 'http://127.0.0.1:3117';
async function main() {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: process.env.MPP_TEST_USER || 'admin', password: process.env.MPP_TEST_PASSWORD || 'admin123' }) });
  assert.equal(login.status, 200);
  const token = (await login.json()).value.token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const money = { id: randomUUID(), name: '支出金额', type: 'money', unit: '元' };
  const choice = { id: randomUUID(), name: '验收状态', type: 'select', options: ['待验收', '合格'] };
  const payload = { name: '自动文件回归', start_date: '2026-11-01', status_date: '2026-11-03', time_granularity: 'day',
    custom_fields: [money, choice], dependencies: [], project_lines: [{ name: '验收线', line_date: '2026-11-04', color: '#123456', visible: true }],
    tasks: ['999999999999999999.99', '0', ''].map((v, i) => ({ task_code: `测试-${31 + i}`, parent_task_code: null,
      name: `文件测试${i}`, start_date: '2026-11-01', end_date: '2026-11-06', duration: 7200,
      percent_done: 20, is_milestone: false, auto_schedule: false, assignee: '计划部', order_index: i,
      custom_values: { [money.id]: v, [choice.id]: '合格' } })),
  };
  const exported = await fetch(`${base}/api/mpp/build`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(300000) });
  if (exported.status !== 200) throw new Error(await exported.text());
  assert.match(exported.headers.get('Content-Type'), /ms-project/);
  const file = await exported.blob();
  const form = new FormData(); form.append('file', file, '测试.mpp');
  const parsed = await fetch(`${base}/api/mpp/parse`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(300000) });
  const data = await parsed.json(); assert.equal(parsed.status, 200, JSON.stringify(data));
  const result = data.value;
  assert.deepEqual(result.custom_fields, [money, choice]);
  assert.deepEqual(result.tasks.map(t => t.custom_values[money.id]), ['999999999999999999.99', '0.00', '']);
  assert.deepEqual(result.tasks.map(t => t.custom_values[choice.id]), ['合格', '合格', '合格']);
  assert.equal(result.tasks[0].start_date, '2026-11-01'); assert.equal(result.tasks[0].duration, 7200);
  assert.equal(result.status_date, '2026-11-03'); assert.deepEqual(result.project_lines, payload.project_lines);
  const invalid = structuredClone(payload); invalid.tasks[0].custom_values[money.id] = '12.345';
  const rejected = await fetch(`${base}/api/mpp/build`, { method: 'POST', headers, body: JSON.stringify(invalid) });
  assert.equal(rejected.status, 400);
  console.log(`PASS MPP HTTP roundtrip: ${base}, ${file.size} bytes, definitions/choices/exact money/zero/blank/dates/status date/lines/validation`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
