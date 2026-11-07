// API integration only. Creates unique fixtures and deletes only those fixtures.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.CUSTOM_FIELDS_TEST_URL || process.argv[2] || 'http://127.0.0.1:3117';
const projects = [];
let token;
let requests = 0;
async function api(path, method = 'GET', body, expected = 200, overrideToken = token) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json',
    ...(overrideToken ? { Authorization: `Bearer ${overrideToken}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const d = await r.json(); requests++;
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(d)}`);
  assert.equal(d.ok, expected < 400);
  return d.value;
}
async function create(extra = {}) {
  const p = await api('/projects', 'POST', { name: `属性回归-${randomUUID().slice(0, 8)}`, start_date: '2026-11-01', status_date: '2026-11-02', use_template: false, ...extra }, 201);
  projects.push(p.id); return p;
}
async function main() {
  token = (await api('/auth/login', 'POST', { login: process.env.CUSTOM_FIELDS_TEST_USER || 'admin', password: process.env.CUSTOM_FIELDS_TEST_PASSWORD || 'admin123' })).token;
  const p = await create(), q = await create();
  const money = { id: randomUUID(), name: '支出金额', type: 'money', unit: '元' };
  const text = { id: randomUUID(), name: '合同编号', type: 'text' };
  const date = { id: randomUUID(), name: '付款日期', type: 'date' };
  const choice = { id: randomUUID(), name: '付款状态', type: 'select', options: ['未支付', '已支付'] };
  const longField = { id: randomUUID(), name: '付款凭证说明'.repeat(10), type: 'text' };
  const fields = [money, text, date, choice, longField];
  assert.deepEqual(p.custom_fields, []);
  const configured = await api(`/projects/${p.id}`, 'PUT', { custom_fields: fields });
  assert.deepEqual(configured.custom_fields, fields);
  await api(`/projects/${p.id}`, 'PUT', { custom_fields: [{ ...money, type: 'text' }] }, 400);
  await api(`/projects/${p.id}`, 'PUT', { custom_fields: [money, { ...text, name: money.name }] }, 400);
  const values = { [money.id]: '999999999999999999.99', [text.id]: '合同 A\n第二行', [date.id]: '2026-11-07', [choice.id]: '已支付' };
  const t = { id: randomUUID(), task_code: '1', name: '设备到货', parent_id: null, start_date: '2026-11-01T00:00:00', end_date: '2026-11-04T00:00:00', duration: 4320, auto_schedule: false, custom_values: values };
  const saved = (await api(`/tasks/${p.id}`, 'POST', [t], 201))[0];
  assert.deepEqual(saved.custom_values, values);
  assert.deepEqual((await api(`/tasks/${p.id}`, 'POST', [t], 201))[0].custom_values, values, 'retry is idempotent');
  assert.deepEqual((await api(`/tasks/${p.id}`)).tasks[0].custom_values, values);
  await api(`/tasks/${q.id}`, 'POST', [{ ...t, id: randomUUID() }], 400);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, name: '修改名称' }]);
  assert.deepEqual((await api(`/tasks/${p.id}`)).tasks[0].custom_values, values, 'old clients preserve custom values');
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '0' } }]);
  let current = (await api(`/tasks/${p.id}`)).tasks[0];
  assert.equal(current.custom_values[money.id], '0.00');
  assert.equal(current.custom_values[text.id], values[text.id]);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '' } }]);
  assert.equal((await api(`/tasks/${p.id}`)).tasks[0].custom_values[money.id], '');
  const t2 = { ...t, id: randomUUID(), task_code: '2', name: '另一任务', custom_values: {} };
  await api(`/tasks/${p.id}`, 'POST', [t2], 201);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '10' } }, { id: t2.id, custom_values: { [date.id]: '2026-02-29' } }], 400);
  assert.equal((await api(`/tasks/${p.id}`)).tasks.find(x => x.id === t.id).custom_values[money.id], '', 'invalid batch rolls back');
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '1.001' } }], 400);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [choice.id]: '不存在' } }], 400);
  assert.equal((await api(`/versions/${p.id}?list=1`)).length, 0, 'draft does not create versions');
  await api(`/versions/${p.id}`, 'POST', { use_database_snapshot: true }, 409);
  await api(`/projects/${p.id}`, 'PUT', { planning_status: 'stable', status_date: '2026-11-07' });
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '123.45', [longField.id]: '历史任务的长名称属性' }, _reason: '补录实际支出' }]);
  const v1 = await api(`/versions/${p.id}`, 'POST', { use_database_snapshot: true, include_snapshot: true, status_date: '2026-11-02', reasons: { '1': '补录实际支出' } }, 201);
  assert.deepEqual(v1.snapshot.custom_fields, fields);
  assert.equal(v1.snapshot.tasks.find(x => x.id === t.id).custom_values[money.id], '123.45');
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '678.90' }, _reason: '新增付款' }]);
  const v2 = await api(`/versions/${p.id}`, 'POST', { use_database_snapshot: true, include_snapshot: true, status_date: '2026-11-03', reasons: { '1': '新增付款' } }, 201);
  assert.ok(v2.changes.diffs.some(d => d.changes?.some(c => c.field === '属性：支出金额' && c.old === '123.45 元' && c.new === '678.90 元')));
  const comparison = await api(`/versions/${p.id}/diff?v1=${v1.id}&v2=${v2.id}`);
  assert.ok(comparison.diffs.some(d => d.changes?.some(c => c.field === '属性：支出金额' && c.new === '678.90 元')));
  await api(`/projects/${p.id}`, 'PUT', { custom_fields: [{ ...money, name: '实际支出', archived: true }, text, date, choice] });
  assert.equal((await api(`/tasks/${p.id}`)).tasks.find(x => x.id === t.id).custom_values[money.id], '678.90');
  const copy = await create({ copy_from: p.id });
  assert.equal(copy.custom_fields[0].name, '实际支出');
  assert.equal((await api(`/tasks/${copy.id}`)).tasks.find(x => x.task_code === '1').custom_values[money.id], '678.90');
  await api(`/versions/${p.id}/restore`, 'POST', { id: v1.id });
  assert.deepEqual((await api(`/projects/${p.id}`)).custom_fields, fields);
  current = (await api(`/tasks/${p.id}`)).tasks.find(x => x.id === t.id);
  assert.equal(current.custom_values[money.id], '123.45');
  assert.equal(current.start_date, saved.start_date, 'attribute edits preserve dates');
  assert.equal(current.end_date, saved.end_date);
  const legacyTasks = (await api(`/tasks/${p.id}`)).tasks.map(({ custom_values, ...old }) => old);
  const legacy = await api(`/versions/${p.id}`, 'POST', { tasks: legacyTasks, dependencies: [], include_snapshot: true, status_date: '2026-11-08' }, 201);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: { [money.id]: '222.22' } }]);
  await api(`/versions/${p.id}/restore`, 'POST', { id: legacy.id });
  assert.equal((await api(`/tasks/${p.id}`)).tasks.find(x => x.id === t.id).custom_values[money.id], '222.22', 'legacy snapshots without values preserve existing data');
  const viewToken = (await api('/auth/login', 'POST', { login: 'view', password: 'view123' })).token;
  await api(`/projects/${p.id}`, 'PUT', { custom_fields: [] }, 403, viewToken);
  await api(`/tasks/${p.id}`, 'PUT', [{ id: t.id, custom_values: {} }], 403, viewToken);
  console.log(`PASS custom field API: ${requests} requests; precision, validation, atomic batches, retry, draft/stable, snapshot restore, copy, legacy clients and readonly roles`);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  for (const id of projects.reverse()) {
    try { await api(`/projects/${id}`, 'DELETE'); } catch (err) { console.error('Fixture cleanup failed', id, err.message); process.exitCode = 1; }
  }
});
