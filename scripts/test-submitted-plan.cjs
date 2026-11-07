// API-only regression. Deletes only the uniquely named projects created below.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const base = process.env.SAVE_TEST_URL || 'http://127.0.0.1:3117';
const projects = [];
const prefix = `提交保护回归-${randomUUID().slice(0, 8)}-`;
let token;
async function api(path, method = 'GET', body, status = 200, confirmed = false) {
  const r = await fetch(`${base}/api${path}`, {method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(confirmed ? {'x-gantt-confirmed-save': '1'} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const d = await r.json();
  assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(d)}`);
  return d;
}
async function project(label) {
  const {value} = await api('/projects', 'POST', {name: prefix + label, status_date: '2026-11-07'}, 201);
  projects.push(value.id);
  return value.id;
}
function task(name, parent_id = null, index = 0) {
  return {id: randomUUID(), name, parent_id, task_code: String(index + 1), order_index: index,
    start_date: '2026-11-08T00:00:00', end_date: '2026-11-10T00:00:00', duration: 2880,
    duration_unit: 'day', auto_schedule: false, percent_done: 0, note: '原备注'};
}
async function state(id) { return (await api(`/tasks/${id}`)).value; }

(async () => {
  token = (await api('/auth/login', 'POST', {login: process.env.SAVE_TEST_ROOT || 'root', password: process.env.SAVE_TEST_PASSWORD || 'root123'})).value.token;
  const p = await project('批量保存'), foreign = await project('跨项目隔离');
  const other = task('其他项目任务');
  await api(`/tasks/${foreign}`, 'POST', [other], 201);
  const original = Array.from({length: 320}, (_, i) => task(`任务 ${i}`, null, i));
  await api(`/tasks/${p}`, 'POST', original, 201);
  const edited = original.map((t, i) => ({...t, name: `用户修改 ${i}`, note: `用户备注 ${i}`,
    start_date: '2026-11-12T00:00:00', end_date: '2026-11-15T00:00:00', duration: 4320}));
  edited[0].parent_id = edited[0].id;
  edited[1].parent_id = randomUUID();
  edited[2].parent_id = other.id;
  edited[3].parent_id = '';
  // No new header: exactly the full-row array contract sent by already-open tabs.
  const result = await api(`/tasks/${p}`, 'PUT', edited);
  assert.equal(result.warnings.length, 3);
  const saved = (await state(p)).tasks;
  assert.equal(saved.length, 320);
  for (const input of edited) {
    const row = saved.find(t => t.id === input.id);
    for (const key of ['name', 'note', 'start_date', 'end_date', 'duration']) assert.equal(row[key], input[key], `${input.name}: ${key}`);
    assert.equal(row.parent_id, null);
  }
  assert.equal((await state(foreign)).tasks[0].name, other.name);
  await api(`/tasks/${p}`, 'PUT', {id: original[0].id, parent_id: other.id}, 400);
  await api(`/tasks/${foreign}`, 'POST', [original[0]], 409);
  const detail = (await api(`/tasks/${p}/${original[0].id}`)).value;
  assert.ok(detail.lifecycle.some(e => e.description.includes('任务不能作为自身父任务')));
  console.log('PASS 320 edits survive invalid/self/foreign parent references; repairs are audited; projects remain isolated');

  const tree = await project('层级与重试');
  const parent = task('旧父任务'), child = task('保留的子任务', parent.id, 1), sibling = task('仍删除的兄弟', parent.id, 2);
  await api(`/tasks/${tree}`, 'POST', [child, sibling, parent], 201);
  assert.equal((await state(tree)).tasks.find(t => t.id === child.id).parent_id, parent.id);
  await api(`/tasks/${tree}`, 'DELETE', {id: parent.id});
  assert.equal((await state(tree)).tasks.length, 0);
  const recovered = {...child, name: '失败后继续编辑', note: '不要丢失这段修改'};
  await api(`/tasks/${tree}`, 'PUT', [recovered]);
  let rows = (await state(tree)).tasks;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(t => t.id === child.id).name, recovered.name);
  assert.equal(rows.find(t => t.id === child.id).parent_id, parent.id);
  assert.ok(rows.some(t => t.id === parent.id));
  assert.ok(!rows.some(t => t.id === sibling.id));
  await api(`/tasks/${tree}`, 'DELETE', {id: parent.id});
  // Old retry flow: POST lost/deleted IDs, then PUT the user's changed values.
  const replay = await api(`/tasks/${tree}`, 'POST', [recovered, parent], 201);
  assert.equal(replay.value.length, 2);
  await api(`/tasks/${tree}`, 'PUT', [recovered, parent]);
  await api(`/tasks/${tree}`, 'POST', [recovered, parent], 201);
  assert.equal((await state(tree)).tasks.length, 2);
  assert.equal((await api(`/tasks/${tree}/${child.id}`)).value.lifecycle.filter(e => e.event_type === 'created').length, 1);
  console.log('PASS both PUT and legacy POST/PUT retries revive retained tasks and required parents without duplicate creation or deleted siblings');

  const target = task('新父任务', null, 3);
  await api(`/tasks/${tree}`, 'POST', [target], 201);
  await api(`/tasks/${tree}`, 'DELETE', {ids: [parent.id]});
  assert.ok((await state(tree)).tasks.some(t => t.id === child.id));
  await api(`/tasks/${tree}`, 'PUT', [{...recovered, parent_id: target.id}]);
  rows = (await state(tree)).tasks;
  assert.equal(rows.find(t => t.id === child.id).parent_id, target.id);
  assert.ok(!rows.some(t => t.id === parent.id));
  await api(`/tasks/${tree}`, 'PUT', [{...target, parent_id: child.id}, {...recovered, parent_id: null}]);
  rows = (await state(tree)).tasks;
  assert.equal(rows.find(t => t.id === target.id).parent_id, child.id);
  assert.equal(rows.find(t => t.id === child.id).parent_id, null);
  await api(`/tasks/${tree}`, 'POST', [target], 201);
  assert.equal((await state(tree)).tasks.find(t => t.id === target.id).parent_id, child.id, 'replayed POST cannot undo a later parent move');
  // Repeating a delete does not duplicate its lifecycle record.
  const deletedCount = (await api(`/tasks/${tree}/${parent.id}`)).value.lifecycle.filter(e => e.event_type === 'deleted').length;
  await api(`/tasks/${tree}`, 'DELETE', {ids: [parent.id]});
  assert.equal((await api(`/tasks/${tree}/${parent.id}`)).value.lifecycle.filter(e => e.event_type === 'deleted').length, deletedCount);
  console.log('PASS removing an old parent preserves retained children; parent reversal uses the final graph; retries do not duplicate deletion logs');

  const scheduling = await project('提交日期优先');
  const a = task('A'), b = {...task('B', null, 1), auto_schedule: true};
  await api(`/tasks/${scheduling}`, 'POST', [a, b], 201);
  const dep = {id: randomUUID(), from_task_id: a.id, to_task_id: b.id, type: 2, lag: 0};
  await api(`/dependencies/${scheduling}`, 'POST', dep, 201);
  const requested = {...b, start_date: '2026-11-20T00:00:00', end_date: '2026-11-25T00:00:00', duration: 7200, note: '用户确认的工期'};
  await api(`/tasks/${scheduling}`, 'PUT', [requested]);
  const once = (await state(scheduling)).tasks.find(t => t.id === b.id);
  const twice = (await state(scheduling)).tasks.find(t => t.id === b.id);
  assert.equal(once.start_date, requested.start_date);
  assert.equal(once.end_date, requested.end_date);
  assert.equal(once.updated_at, twice.updated_at);
  await api(`/dependencies/${scheduling}`, 'PUT', {...dep, lag: 1440}, 200, true);
  assert.equal((await state(scheduling)).tasks.find(t => t.id === b.id).start_date, requested.start_date);
  const beforeFailure = await state(scheduling);
  await api(`/tasks/${scheduling}`, 'PUT', [{...a, name: '不应被忽略的新名称'}, {...task('后端缺失任务')}], 404);
  assert.deepEqual(await state(scheduling), beforeFailure);
  await api(`/tasks/${scheduling}`, 'PUT', [{...a, name: '不应部分提交'}, {...requested, start_date: '2027-01-01'}], 400);
  assert.deepEqual(await state(scheduling), beforeFailure);
  await api(`/tasks/${scheduling}`, 'PUT', [{...requested, start_date: null, end_date: null, duration: null, note: null}]);
  const cleared = (await state(scheduling)).tasks.find(t => t.id === b.id);
  for (const key of ['start_date', 'end_date', 'duration', 'note']) assert.equal(cleared[key], null);
  console.log('PASS submitted schedule wins over stale server dependencies; GET is read-only; invalid batches roll back; explicit clears persist');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  for (const id of projects) {
    try { await api(`/projects/${id}`, 'DELETE'); } catch (e) {console.error('Fixture cleanup:', e.message); process.exitCode = 1;}
  }
  console.log(`Removed ${projects.length} owned test projects`);
});
