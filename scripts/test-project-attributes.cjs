// Licensed, actual MPP read/write test. No browser automation or database writes.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const temp = mkdtempSync(path.join(tmpdir(), 'gantt-project-test-'));
const dll = path.resolve('aspose-tasks-cli/publish/aspose-tasks-cli.dll');
function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(r.status, 0, `${command} ${args.join(' ')}\n${r.stderr}\n${r.stdout}\n${r.error || ''}`);
  return r.stdout;
}
function field(name, type, extra = {}) { return { id: randomUUID(), name, type, ...extra }; }
const money = field('支出金额', 'money', { unit: '元' });
const big = field('大额预算', 'money', { unit: '元' });
const number = field('精确数量', 'number', { unit: '台' });
const text = field('合同编号', 'text');
const date = field('付款日期', 'date');
const choice = field('付款状态', 'select', { options: ['未付款', '已付款'] });
const archived = field('旧字段', 'text', { archived: true });
const fields = [money, big, number, text, date, choice, archived];
function task(code, values, extra = {}) {
  return { task_code: code, parent_task_code: null, name: `任务${code}`, start_date: '2026-11-01', end_date: '2026-11-06',
    duration: 7200, percent_done: 40, is_milestone: false, auto_schedule: false, order_index: 0, note: '保留注释', assignee: '计划部', custom_values: values, ...extra };
}
const input = { name: '属性交换测试', start_date: '2026-11-01', status_date: '2026-11-03', time_granularity: 'day', custom_fields: fields,
  project_lines: [{ name: '验收线', line_date: '2026-11-04', color: '#336699', visible: true }],
  tasks: [
    task('采购-31', { [money.id]: '123.45', [big.id]: '999999999999999999.99', [number.id]: '1.12345678', [text.id]: '000123\n第二行', [date.id]: '2026-11-07', [choice.id]: '已付款', [archived.id]: '保留' }),
    task('到货-99', { [money.id]: '0.00', [big.id]: '0.00', [choice.id]: '' }, { order_index: 1 }),
    task('组-77', {}, { order_index: 2 }),
    task('子任务-88', { [money.id]: '-12.30' }, { parent_task_code: '组-77' }),
  ], dependencies: [{ from_task_code: '采购-31', to_task_code: '到货-99', type: 2, lag: 1440, active: false }],
};
let sequence = 0;
function build(payload, expectedError) {
  const id = sequence++;
  const json = path.join(temp, `${id}.json`), mpp = path.join(temp, `${id}.mpp`);
  writeFileSync(json, JSON.stringify(payload));
  if (expectedError) {
    const r = spawnSync('dotnet', [dll, 'export', json, mpp], { encoding: 'utf8', timeout: 300000 });
    assert.notEqual(r.status, 0); assert.match(r.stderr, expectedError); return;
  }
  run('dotnet', [dll, 'export', json, mpp]); return mpp;
}
function read(mpp) { return JSON.parse(run('dotnet', [dll, 'import', mpp])); }
try {
  assert.ok(process.env.ASPOSE_TASKS_LICENSE, 'Set ASPOSE_TASKS_LICENSE');
  const original = build(input), result = read(original);
  assert.equal(result.tasks.length, input.tasks.length);
  assert.deepEqual(result.custom_fields.map(({ archived, unit, options, ...f }) => ({ ...f, ...(archived ? { archived } : {}), ...(unit ? { unit } : {}), ...(options ? { options } : {}) })), fields);
  for (const item of input.tasks) {
    const t = result.tasks.find(t => t.task_code === item.task_code);
    for (const f of fields) assert.equal(t.custom_values[f.id], item.custom_values[f.id] ?? '', `${item.task_code} ${f.name}`);
    assert.equal(t.parent_task_code, item.parent_task_code ?? '');
    assert.equal(t.start_date, item.start_date); assert.equal(t.end_date, item.end_date);
    assert.equal(t.duration, item.duration); assert.equal(t.assignee, '计划部');
  }
  assert.equal(result.time_granularity, 'day'); assert.equal(result.status_date, input.status_date);
  assert.deepEqual(result.project_lines, input.project_lines);
  assert.ok(result.dependencies.some(d => d.active === false && d.lag === 1440));
  const edited = path.join(temp, 'edited.mpp'), external = path.join(temp, 'external.mpp');
  run('dotnet', ['aspose-tasks-tests/bin/Release/net8.0/AsposeTasksTests.dll', original, edited, external]);
  assert.equal(read(edited).tasks.find(t => t.task_code === '采购-31').custom_values[money.id], '234.56');
  const native = read(external);
  const nativeValues = Object.fromEntries(native.custom_fields.map(f => [f.name, native.tasks[0].custom_values[f.id]]));
  assert.deepEqual(nativeValues, { '外部金额': '321.09', '合同编号': '000123', '已验收': '否', '外部付款日期': '2026-11-07' });
  const minute = read(build({ ...input, time_granularity: 'minute', tasks: [task('1', {}, { start_date: '2026-11-01T08:00:00', end_date: '2026-11-01T08:45:00', duration: 45 })], dependencies: [] }));
  assert.equal(minute.tasks[0].duration, 45); assert.equal(minute.tasks[0].start_date, '2026-11-01T08:00:00');
  build({ ...input, tasks: [task('1', { [text.id]: 'x'.repeat(256) })], dependencies: [] }, /255/);
  build({ ...input, custom_fields: Array.from({ length: 31 }, (_, i) => field(`字段${i}`, 'text')), tasks: [task('1', {})], dependencies: [] }, /没有可用/);
  build({ ...input, tasks: [task('1', {}), task('1', {})], dependencies: [] }, /任务编码重复/);
  console.log('PASS Project MPP: seven field types/states, exact money, zero/blank, hierarchy, dates, status date, lines, resources, minute precision, native edits/imports and explicit overflow errors');
} finally { rmSync(temp, { recursive: true, force: true }); }
