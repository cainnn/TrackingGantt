// Real database and browser regression. Uses only temporary projects in this run.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { planTaskDeletion } = require('../.test-dist/lib/taskDeletion.js');
const { findPlanSaveMismatches } = require('../.test-dist/lib/planSaveVerification.js');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const login = process.env.SAVE_TEST_ROOT || 'root', password = process.env.SAVE_TEST_PASSWORD || 'root123';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-save-verification-'));
const projects = [];
let token, browser, page;
async function request(route, method = 'GET', body, expected = 200, revision) {
  const response = await fetch(`${base}/api${route}`, { method, signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'x-gantt-confirmed-save': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(revision ? { 'x-gantt-plan-revision': revision } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, expected < 400);
  return { value: data.value, error: data.error, revision: response.headers.get('x-gantt-plan-revision') };
}
const api = async (...args) => (await request(...args)).value;
const state = id => api(`/tasks/${id}?save_state=1`);
async function fixture(precision, label) {
  const unit = precision === 'day' ? 1440 : 60;
  const epoch = Date.UTC(2030, 0, 1, precision === 'minute' ? 9 : 0, precision === 'minute' ? 15 : 0);
  const at = offset => new Date(epoch + offset * unit * 60000).toISOString().slice(0, 19);
  const project = await api('/projects', 'POST', { name: `保存校验-${label}-${precision}-${randomUUID().slice(0, 8)}`,
    start_date: '2030-01-01', status_date: '2030-01-01', time_granularity: precision, use_template: false }, 201);
  projects.push(project.id);
  const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(key => [key, randomUUID()]));
  const times = { a: [0, 1], b: [0, 2], c: [0, 3], d: [3, 4], e: [4, 5], f: [5, 6], g: [6, 7] };
  await api(`/tasks/${project.id}`, 'POST', Object.entries(ids).map(([key, id], index) => ({ id, name: key.toUpperCase(), parent_id: null,
    task_code: String(index + 1), order_index: index, auto_schedule: true, constraint_type: 'asap', start_date: at(times[key][0]),
    end_date: at(times[key][1]), duration: (times[key][1] - times[key][0]) * unit, duration_unit: precision })), 201);
  for (const [from, to] of [['a', 'd'], ['b', 'd'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g']])
    await api(`/dependencies/${project.id}`, 'POST', { from_task_id: ids[from], to_task_id: ids[to], type: 2, lag: 0 }, 201);
  await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: {
    id: 'current', name: '验收布局', search: '', columns: ['start', 'end', 'duration', 'pred'], colW: precision === 'minute' ? 720 : 28,
    critical: false, indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null,
      widths: {}, nameWidth: 160, panelWidth: 1000, panelCollapsed: false, rightCollapsed: false, centerTime: epoch, scrollTop: 0 },
  } });
  return { project, ids, at, unit };
}
function expectedDeletion(before, id) {
  const plan = planTaskDeletion(before.tasks, before.dependencies, [id], { deletionDate: '2029-01-01' });
  return { ...before, tasks: plan.tasks, dependencies: plan.dependencies, plan };
}
async function click(label) {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(button => button.getClientRects().length
    && (button.textContent.trim() === label || button.title === label)), label);
  assert.ok(handle.asElement(), `Missing button ${label}`);
  await page.evaluate(() => { window.__saveClickCount = 0; window.__saveClickProbe = () => window.__saveClickCount++;
    document.addEventListener('click', window.__saveClickProbe, true); });
  await handle.asElement().click();
  const delivered = await page.evaluate(() => { document.removeEventListener('click', window.__saveClickProbe, true); return window.__saveClickCount; });
  if (!delivered) await handle.evaluate(button => button.click());
  await handle.dispose();
}
const cell = (id, column) => `[data-task-cell="${id}"][data-col="${column}"]`;
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function open(f) {
  // Account state is held in Redux; enter through the normal login + SPA link.
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(key => key.startsWith('__reactProps$')));
  await page.type('input[type=text]', login); await page.type('input[type=password]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${f.project.id}"]`);
  await page.$eval(`a[href="/projects/${f.project.id}"]`, link => link.click());
  await page.waitForSelector(cell(f.ids.c, 'name'));
}
async function removeC(f) {
  await page.click(cell(f.ids.c, 'name'));
  await click('删除选中任务');
  await page.waitForSelector(cell(f.ids.c, 'name'), { hidden: true });
  await page.waitForFunction((selector, value) => document.querySelector(selector)?.textContent.trim() === value, {}, cell(f.ids.d, 'start'), f.at(2).slice(2, 10));
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  for (const precision of ['day', 'minute']) {
    const f = await fixture(precision, 'API'), before = await state(f.project.id), target = expectedDeletion(before, f.ids.c);
    assert.match(before.revision, /^[a-f0-9]{64}$/);
    const update = await request(`/tasks/${f.project.id}`, 'PUT', target.plan.updatedTasks, 200, before.revision);
    assert.match(update.revision, /^[a-f0-9]{64}$/);
    const deletion = await request(`/tasks/${f.project.id}`, 'DELETE', { ids: [f.ids.c] }, 200, update.revision);
    const saved = await state(f.project.id);
    assert.equal(saved.revision, deletion.revision);
    assert.deepEqual(findPlanSaveMismatches(target, saved), []);
    const raced = await Promise.all(['会话一', '会话二'].map(name => fetch(`${base}/api/tasks/${f.project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        'x-gantt-confirmed-save': '1', 'x-gantt-plan-revision': saved.revision }, body: JSON.stringify([{ id: f.ids.d, name }]),
    })));
    assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
    const latest = await state(f.project.id);
    const stale = await request(`/tasks/${f.project.id}`, 'PUT', [{ id: f.ids.d, name: '不应覆盖后台' }], 409, saved.revision);
    assert.match(stale.error, /后台计划已/);
    assert.equal((await state(f.project.id)).revision, latest.revision);
    const dep = latest.dependencies.find(dep => dep.from_task_id === f.ids.a);
    await request(`/dependencies/${f.project.id}`, 'PUT', { id: dep.id, lag: 10 }, 200, latest.revision);
    await request(`/tasks/${f.project.id}`, 'PUT', [{ id: f.ids.e, note: '旧图上的修改' }], 409, latest.revision);
    const graph = await state(f.project.id);
    const stable = await request(`/projects/${f.project.id}`, 'PUT', { planning_status: 'stable' }, 200, graph.revision);
    const line = { id: randomUUID(), name: '校验线', line_date: '2030-01-02', color: '#ff0000', visible: true };
    await request(`/project-lines/${f.project.id}`, 'POST', line, 409, graph.revision);
    const createdLine = await request(`/project-lines/${f.project.id}`, 'POST', line, 201, stable.revision);
    await request(`/project-lines/${f.project.id}`, 'PUT', { ...line, name: '不应覆盖' }, 409, stable.revision);
    const changedLine = await request(`/project-lines/${f.project.id}`, 'PUT', { ...line, name: '已校验修改' }, 200, createdLine.revision);
    const removedLine = await request(`/project-lines/${f.project.id}`, 'DELETE', { id: line.id }, 200, changedLine.revision);
    await request(`/versions/${f.project.id}`, 'POST', { use_database_snapshot: true, status_date: '2030-01-01' }, 409, graph.revision);
    assert.equal((await api(`/versions/${f.project.id}?list=1`)).length, 0);
    const version = await request(`/versions/${f.project.id}`, 'POST', { use_database_snapshot: true, status_date: '2030-01-01' }, 201, removedLine.revision);
    assert.equal(version.revision, removedLine.revision);
    const middle = randomUUID(), manual = randomUUID();
    await api(`/tasks/${f.project.id}`, 'POST', [
      { id: middle, task_code: '8', name: '删除中间节点', start_date: f.at(5), end_date: f.at(6), duration: f.unit },
      { id: manual, task_code: '9', name: '保留手动后继', start_date: f.at(8), end_date: f.at(9), duration: f.unit, auto_schedule: false },
    ], 201);
    await api(`/dependencies/${f.project.id}`, 'POST', { from_task_id: f.ids.a, to_task_id: middle, type: 2, lag: 0 }, 201);
    await api(`/dependencies/${f.project.id}`, 'POST', { from_task_id: middle, to_task_id: manual, type: 2, lag: 0 }, 201);
    const manualBefore = await state(f.project.id), manualTarget = expectedDeletion(manualBefore, middle);
    assert.equal(manualTarget.tasks.find(t => t.id === manual).auto_schedule, false);
    const removedMiddle = await request(`/tasks/${f.project.id}`, 'DELETE', { ids: [middle] }, 200, manualBefore.revision);
    let manualRevision = removedMiddle.revision;
    for (const dependency of manualTarget.plan.newDependencies) {
      const savedDependency = await request(`/dependencies/${f.project.id}`, 'POST', dependency, 201, manualRevision);
      manualRevision = savedDependency.revision;
    }
    const manualSaved = await state(f.project.id);
    assert.deepEqual(findPlanSaveMismatches(manualTarget, manualSaved), []);
    assert.equal(manualSaved.tasks.find(t => t.id === manual).auto_schedule, false);
    assert.equal(manualSaved.tasks.find(t => t.id === manual).start_date.slice(0, 19), f.at(8));
    console.log(`PASS ${precision}: full cascade persists, tokens advance, simultaneous saves have one winner, stale task/graph writes return 409`);
    console.log(`PASS ${precision}: project state, project-line create/update/delete and stable snapshots enforce the same revision check`);
    console.log(`PASS ${precision}: saving replacement links preserves a manual successor's mode and dates`);
  }

  const f = await fixture('day', 'browser'), before = await state(f.project.id), target = expectedDeletion(before, f.ids.c);
  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1080 });
  page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(90000);
  const dialogs = [], errors = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  page.on('pageerror', error => errors.push(error.message));
  await open(f); await removeC(f);
  assert.deepEqual(findPlanSaveMismatches(before, await state(f.project.id)), []);
  await click('保存');
  await page.waitForFunction(() => document.querySelector('[data-action=save-plan]')?.disabled && !document.querySelector('[data-action=save-plan]').textContent.includes('保存中'));
  assert.deepEqual(findPlanSaveMismatches(target, await state(f.project.id)), []);
  await open({ ...f, ids: { ...f.ids, c: f.ids.d } });
  assert.match(await page.$eval(cell(f.ids.g, 'start'), el => el.textContent), new RegExp(f.at(5).slice(2, 10)));
  console.log('PASS browser: deletion collapses D/E/F/G locally, save persists every shifted date, and reopening matches the database');

  const conflict = await fixture('day', 'conflict');
  await open(conflict); await removeC(conflict);
  await api(`/tasks/${conflict.project.id}`, 'PUT', [{ id: conflict.ids.d, name: '另一个人保存的新名称' }]);
  const remote = await state(conflict.project.id), count = dialogs.length;
  await click('保存');
  await waitUntil(() => dialogs.length > count, 'conflict notification');
  await page.waitForFunction(() => !document.querySelector('[data-action=save-plan]').disabled && !document.querySelector('[data-action=save-plan]').textContent.includes('保存中'));
  assert.ok(dialogs.slice(count).some(message => message.includes('后台计划存在冲突')));
  assert.equal((await state(conflict.project.id)).revision, remote.revision);
  assert.equal(await page.$(cell(conflict.ids.c, 'name')), null);
  console.log('PASS browser: a stale local deletion stops before writes, preserves the remote edit and keeps the local draft');

  const mismatch = await fixture('day', 'readback'), mismatchBefore = await state(mismatch.project.id), mismatchTarget = expectedDeletion(mismatchBefore, mismatch.ids.c);
  await open(mismatch); await removeC(mismatch);
  let injected = false;
  await page.setRequestInterception(true);
  page.on('request', async req => {
    if (!injected && req.method() === 'PUT' && new URL(req.url()).pathname === `/api/tasks/${mismatch.project.id}`) {
      injected = true;
      const body = JSON.parse(req.postData()).map(task => task.id === mismatch.ids.f ? { ...task, start_date: mismatch.at(5), end_date: mismatch.at(6) } : task);
      const response = await fetch(req.url(), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        'x-gantt-confirmed-save': '1', 'x-gantt-plan-revision': req.headers()['x-gantt-plan-revision'] }, body: JSON.stringify(body) });
      await req.respond({ status: response.status, headers: { 'Content-Type': 'application/json',
        'x-gantt-plan-revision': response.headers.get('x-gantt-plan-revision') || '' }, body: await response.text() });
    } else await req.continue();
  });
  const mismatchCount = dialogs.length;
  await click('保存');
  await waitUntil(() => dialogs.length > mismatchCount, 'readback mismatch notification');
  await page.waitForFunction(() => !document.querySelector('[data-action=save-plan]').disabled && !document.querySelector('[data-action=save-plan]').textContent.includes('保存中'));
  assert.equal(injected, true);
  assert.ok(dialogs.slice(mismatchCount).some(message => message.includes('保存结果核对未通过')));
  assert.ok(findPlanSaveMismatches(mismatchTarget, await state(mismatch.project.id)).some(issue => issue.includes('「F」')));
  await click('保存');
  await page.waitForFunction(() => document.querySelector('[data-action=save-plan]')?.disabled && !document.querySelector('[data-action=save-plan]').textContent.includes('保存中'));
  assert.deepEqual(findPlanSaveMismatches(mismatchTarget, await state(mismatch.project.id)), []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'saved.png'), fullPage: true });
  console.log(`PASS browser: a successful HTTP reply with wrong stored F dates is not marked saved; retry restores the intended cascade. Artifacts: ${output}`);
}
main().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ output }); })
  .finally(async () => { if (browser) await browser.close(); for (const id of projects.reverse()) await api(`/projects/${id}`, 'DELETE').catch(error => { console.error(error.message); process.exitCode = 1; }); console.log(`Cleaned ${projects.length} verification projects`); });
